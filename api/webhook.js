const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    })
  });
}

const db = getFirestore();

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {

    const data = req.body;

    console.log(data);

    const orderId =
      data.order_id ||
      data.order_description;

    if (!orderId) {
      return res.status(400).send("Order ID Missing");
    }

    const orderRef =
      db.collection("orders")
      .doc(orderId);

    const snap =
      await orderRef.get();

    if (!snap.exists) {
      return res.status(404).send("Order Not Found");
    }

    const order =
      snap.data();

    await orderRef.update({

      status:
        data.payment_status,

      confirmations:
        data.confirmations || 0,

      txHash:
        data.payin_hash || null,

      paidAt:
        Date.now()

    });

    if (data.payment_status === "finished") {

      await db
        .collection("users")
        .doc(order.uid)
        .update({

          vip: true,

          vipType: "gold",

          vipMultiplier: 4,

          vipBoost: 4,

          vipActivatedAt:
            Date.now()

        });

      console.log("VIP Activated");

    }

    res.status(200).send("OK");

  } catch (err) {

    console.error(err);

    res.status(500).send(err.message);

  }

};