const crypto = require("crypto");
const { auth, db, FieldValue } = require("./firebase-admin");

const VIP_PRICE_USD = 10;
const DEFAULT_PAY_CURRENCY = "usdtbsc";
const NOWPAYMENTS_INVOICE_URL = "https://api.nowpayments.io/v1/invoice";
const ORDER_TTL_MS = 60 * 60 * 1000;

function getBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || process.env.FIREBASE_PUBLIC_URL || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`).replace(/\/$/, "");
}

function sendJson(res, status, payload) { return res.status(status).json(payload); }

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, error: "Method Not Allowed" });
  }

  try {
    if (!process.env.NOWPAYMENTS_API_KEY) return sendJson(res, 500, { success: false, error: "NOWPAYMENTS_API_KEY is not configured" });

    const { uid, idToken } = req.body || {};
    if (!uid) return sendJson(res, 400, { success: false, error: "UID is required" });

    if (idToken) {
      const decoded = await auth.verifyIdToken(idToken);
      if (decoded.uid !== uid) return sendJson(res, 403, { success: false, error: "Authenticated user does not match requested UID" });
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists && userSnap.data().vip === true) return sendJson(res, 409, { success: false, error: "VIP is already active" });

    const orderId = `VIP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const baseUrl = getBaseUrl(req);
    const orderRef = db.collection("orders").doc(orderId);

    await orderRef.set({
      uid,
      amountUSD: VIP_PRICE_USD,
      currency: "usd",
      payCurrency: process.env.NOWPAYMENTS_PAY_CURRENCY || DEFAULT_PAY_CURRENCY,
      status: "waiting",
      paymentStatus: "waiting",
      vipActivated: false,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + ORDER_TTL_MS)
    });

    const invoicePayload = {
      price_amount: VIP_PRICE_USD,
      price_currency: "usd",
      pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY || DEFAULT_PAY_CURRENCY,
      order_id: orderId,
      order_description: "LEXA GOLD VIP",
      ipn_callback_url: process.env.NOWPAYMENTS_IPN_CALLBACK_URL || `${baseUrl}/api/webhook`,
      success_url: process.env.NOWPAYMENTS_SUCCESS_URL || `${baseUrl}/vip.html?order=${encodeURIComponent(orderId)}`,
      cancel_url: process.env.NOWPAYMENTS_CANCEL_URL || `${baseUrl}/vip.html?cancelled=1`
    };

    const response = await fetch(NOWPAYMENTS_INVOICE_URL, {
      method: "POST",
      headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(invoicePayload)
    });

    const raw = await response.text();
    let invoice;
    try { invoice = raw ? JSON.parse(raw) : {}; } catch (_) {
      await orderRef.update({ status: "invoice_failed", paymentStatus: "invoice_failed", error: raw, updatedAt: FieldValue.serverTimestamp() });
      return sendJson(res, 502, { success: false, error: "Invalid response from NOWPayments" });
    }

    if (!response.ok || !invoice.id) {
      await orderRef.update({ status: "invoice_failed", paymentStatus: "invoice_failed", nowpaymentsError: invoice, updatedAt: FieldValue.serverTimestamp() });
      return sendJson(res, response.status || 502, { success: false, error: invoice.message || "Failed to create invoice", details: invoice });
    }

    await orderRef.update({
      invoiceId: String(invoice.id),
      invoiceUrl: invoice.invoice_url || invoice.payment_url || null,
      payAddress: invoice.pay_address || null,
      payAmount: invoice.pay_amount || null,
      nowpayments: invoice,
      updatedAt: FieldValue.serverTimestamp()
    });

    return sendJson(res, 200, { success: true, orderId, invoice });
  } catch (error) {
    console.error("create-invoice error", error);
    return sendJson(res, 500, { success: false, error: "Unable to create invoice" });
  }
};
