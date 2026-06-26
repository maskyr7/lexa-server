const crypto = require("crypto");
const { db, FieldValue } = require("./firebase-admin");

const VIP_PRICE_USD = 10;
const FINAL_STATUSES = new Set(["finished", "confirmed"]);

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((acc, key) => { acc[key] = sortObject(value[key]); return acc; }, {});
  return value;
}
function timingSafeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function isExactVipPayment(data, order) {
  const priceAmount = Number(data.price_amount ?? order.amountUSD);
  const priceCurrency = String(data.price_currency || order.currency || "usd").toLowerCase();
  return priceCurrency === "usd" && Math.abs(priceAmount - VIP_PRICE_USD) < 0.000001 && Number(order.amountUSD) === VIP_PRICE_USD;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).send("Method Not Allowed"); }
  try {
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET || process.env.NOWPAYMENTS_IPN_KEY;
    if (!ipnSecret) return res.status(500).send("NOWPayments IPN secret is not configured");
    const signature = String(req.headers["x-nowpayments-sig"] || "").toLowerCase();
    if (!signature) return res.status(401).send("Missing Signature");
    const expected = crypto.createHmac("sha512", ipnSecret).update(JSON.stringify(sortObject(req.body || {}))).digest("hex");
    if (!timingSafeEqualHex(signature, expected)) return res.status(401).send("Invalid Signature");

    const data = req.body || {};
    const orderId =
data.order_id ||
data.order_description;
    if (!orderId) return res.status(400).send("Order ID Missing");

    const orderRef = db.collection("orders").doc(String(orderId));
    const result = await db.runTransaction(async transaction => {
      const snap = await transaction.get(orderRef);
      if (!snap.exists) return { code: 404, message: "Order Not Found" };
      const order = snap.data();
      const paymentStatus = String(data.payment_status || "").toLowerCase();
      const exactPayment = isExactVipPayment(data, order);
      const shouldActivate = FINAL_STATUSES.has(paymentStatus) && exactPayment && order.vipActivated !== true;

      transaction.update(orderRef, {
        status: paymentStatus || "unknown",
        paymentStatus: paymentStatus || "unknown",
        paymentId: data.payment_id || null,
        invoiceId: data.invoice_id ? String(data.invoice_id) : order.invoiceId || null,
        confirmations: Number(data.confirmations || 0),
        txHash: data.payin_hash || data.purchase_id || null,
        actuallyPaid: data.actually_paid || null,
        priceAmount: data.price_amount || null,
        priceCurrency: data.price_currency || null,
        exactPayment,
lastWebhook: {
  status: data.payment_status,
  payment_id: data.payment_id,
  payin_hash: data.payin_hash,
  confirmations: data.confirmations
},
updatedAt: FieldValue.serverTimestamp()
      });

      if (!shouldActivate) return { code: 200, message: exactPayment ? "Payment recorded" : "Payment recorded but not eligible for VIP activation" };

      transaction.update(orderRef, { vipActivated: true, vipActivatedAt: FieldValue.serverTimestamp(), paidAt: FieldValue.serverTimestamp() });
      transaction.set(db.collection("users").doc(order.uid), {
        vip: true, vipType: "gold", vipMultiplier: 4, vipBoost: 4, vipOrderId: orderId, vipActivatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { code: 200, message: "VIP Activated" };
    });
    return res.status(result.code).send(result.message);
  } catch (error) {
    console.error("webhook error", error);
    return res.status(500).send("Webhook processing failed");
  }
};
