require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const IS_LIVE = String(process.env.SSLCZ_IS_LIVE).toLowerCase() === "true";
const STORE_ID = process.env.SSLCZ_STORE_ID || "";
const STORE_PASSWORD = process.env.SSLCZ_STORE_PASSWORD || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const db = new Database(path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'topup',
  product TEXT,
  package_name TEXT,
  uid TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  amount REAL NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  tran_id TEXT UNIQUE,
  val_id TEXT,
  bank_tran_id TEXT,
  gateway_response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  customer_phone TEXT PRIMARY KEY,
  customer_name TEXT,
  customer_email TEXT,
  balance REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  customer_phone TEXT NOT NULL,
  amount REAL NOT NULL,
  tran_id TEXT UNIQUE,
  val_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  gateway_response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const PRODUCTS = {
  "UID TOPUP": [
    ["25 DIAMOND", 22], ["50 DIAMOND", 38], ["115 DIAMOND", 79],
    ["240 DIAMOND", 155], ["610 DIAMOND", 400], ["1240 DIAMOND", 800],
    ["2530 DIAMOND", 1610], ["WEEKLY", 158], ["MONTHLY", 780], ["WEEKLY LITE", 40]
  ],
  "FF WEEKLY OFFER": [["Weekly", 158]],
  "FF MONTHLY OFFER": [["Monthly", 780]],
  "FF LV PASS": [
    ["LVL-6", 40], ["LVL-10", 70], ["LVL-15", 70], ["LVL-20", 70],
    ["LVL-25", 70], ["LVL-30", 100], ["LVL UP PASS ALL", 420]
  ],
  "WEEKLY FRIDAY": [["Weekly Friday", 100]],
  "FF LIKE": [["100 LIKE", 10], ["200 LIKE", 15]]
};

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
const safeJson = (v) => { try { return JSON.stringify(v); } catch { return "{}"; } };

function sslBase() {
  return IS_LIVE ? "https://securepay.sslcommerz.com" : "https://sandbox.sslcommerz.com";
}
function sslConfig() {
  if (!STORE_ID || !STORE_PASSWORD) throw new Error("SSLCOMMERZ credentials are not configured");
  return { base: sslBase(), store_id: STORE_ID, store_passwd: STORE_PASSWORD };
}
function publicUrl(p) { return `${BASE_URL}${p}`; }

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/products", (req, res) => res.json(PRODUCTS));

function getPackage(product, packageName) {
  const list = PRODUCTS[product] || [];
  const found = list.find(x => x[0] === packageName);
  return found ? { name: found[0], price: Number(found[1]) } : null;
}

function validateCustomer(body) {
  const name = String(body.name || "").trim().slice(0, 80);
  const phone = String(body.phone || "").trim().slice(0, 30);
  const email = String(body.email || "").trim().slice(0, 120);
  if (!name || !phone || !email) throw new Error("Name, phone and email are required");
  return { name, phone, email };
}

async function createSslSession({ amount, tranId, name, email, phone, productName }) {
  const c = sslConfig();
  const params = new URLSearchParams();
  params.set("store_id", c.store_id);
  params.set("store_passwd", c.store_passwd);
  params.set("total_amount", Number(amount).toFixed(2));
  params.set("currency", "BDT");
  params.set("tran_id", tranId);
  params.set("success_url", publicUrl("/payment/success"));
  params.set("fail_url", publicUrl("/payment/fail"));
  params.set("cancel_url", publicUrl("/payment/cancel"));
  params.set("ipn_url", publicUrl("/payment/ipn"));
  params.set("cus_name", name);
  params.set("cus_email", email);
  params.set("cus_phone", phone);
  params.set("cus_add1", "Bangladesh");
  params.set("cus_city", "Dhaka");
  params.set("cus_country", "Bangladesh");
  params.set("shipping_method", "NO");
  params.set("product_name", productName.slice(0, 255));
  params.set("product_category", "top up");
  params.set("product_profile", "general");

  const url = `${c.base}/gwprocess/v4/api.php`;
  const response = await axios.post(url, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000
  });
  return response.data;
}

async function validateSsl(valId) {
  const c = sslConfig();
  const url = `${c.base}/validator/api/validationserverAPI.php`;
  const response = await axios.get(url, {
    params: {
      val_id: valId,
      store_id: c.store_id,
      store_passwd: c.store_passwd,
      format: "json",
      v: 1
    },
    timeout: 20000
  });
  return response.data;
}

function adminOnly(req, res, next) {
  if (!ADMIN_KEY || req.get("x-admin-key") !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/api/order/initiate", async (req, res) => {
  try {
    const { product, packageName, uid } = req.body;
    const customer = validateCustomer(req.body);
    const pkg = getPackage(product, packageName);
    const cleanUid = String(uid || "").trim().slice(0, 100);
    if (!pkg) return res.status(400).json({ error: "Invalid product/package" });
    if (!cleanUid) return res.status(400).json({ error: "UID / Player ID is required" });

    const orderId = id("RSO");
    const tranId = id("RST");
    const created = now();

    db.prepare(`
      INSERT INTO orders
      (id,type,product,package_name,uid,customer_name,customer_phone,customer_email,amount,status,payment_status,tran_id,created_at,updated_at)
      VALUES (@id,'topup',@product,@package_name,@uid,@name,@phone,@email,@amount,'PENDING','UNPAID',@tran_id,@created_at,@updated_at)
    `).run({
      id: orderId, product, package_name: pkg.name, uid: cleanUid,
      name: customer.name, phone: customer.phone, email: customer.email,
      amount: pkg.price, tran_id: tranId, created_at: created, updated_at: created
    });

    const gateway = await createSslSession({
      amount: pkg.price, tranId, name: customer.name, email: customer.email,
      phone: customer.phone, productName: `${product} - ${pkg.name}`
    });

    if (gateway.status !== "SUCCESS" || !gateway.GatewayPageURL) {
      db.prepare("UPDATE orders SET status='FAILED', gateway_response=?, updated_at=? WHERE id=?")
        .run(safeJson(gateway), now(), orderId);
      return res.status(502).json({ error: "Payment gateway session failed", details: gateway.failedreason || "" });
    }

    res.json({ orderId, tranId, paymentUrl: gateway.GatewayPageURL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/api/wallet/initiate", async (req, res) => {
  try {
    const customer = validateCustomer(req.body);
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 10 || amount > 500000) {
      return res.status(400).json({ error: "Amount must be between 10 and 500000 BDT" });
    }

    const walletTxId = id("RWT");
    const tranId = id("RWA");
    const created = now();

    db.prepare(`
      INSERT INTO wallet_transactions
      (id,customer_phone,amount,tran_id,status,created_at,updated_at)
      VALUES (?,?,?,?, 'PENDING',?,?)
    `).run(walletTxId, customer.phone, amount, tranId, created, created);

    db.prepare(`
      INSERT INTO wallets(customer_phone,customer_name,customer_email,balance,updated_at)
      VALUES(?,?,?,0,?)
      ON CONFLICT(customer_phone) DO UPDATE SET customer_name=excluded.customer_name,
      customer_email=excluded.customer_email, updated_at=excluded.updated_at
    `).run(customer.phone, customer.name, customer.email, created);

    const gateway = await createSslSession({
      amount, tranId, name: customer.name, email: customer.email,
      phone: customer.phone, productName: "RS Top Up Wallet Add Money"
    });

    if (gateway.status !== "SUCCESS" || !gateway.GatewayPageURL) {
      db.prepare("UPDATE wallet_transactions SET status='FAILED',gateway_response=?,updated_at=? WHERE id=?")
        .run(safeJson(gateway), now(), walletTxId);
      return res.status(502).json({ error: "Payment gateway session failed" });
    }

    res.json({ walletTxId, tranId, paymentUrl: gateway.GatewayPageURL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

function findOrderByTran(tranId) {
  return db.prepare("SELECT * FROM orders WHERE tran_id=?").get(tranId);
}
function findWalletTxByTran(tranId) {
  return db.prepare("SELECT * FROM wallet_transactions WHERE tran_id=?").get(tranId);
}

const markPaidOrder = db.transaction((order, validation) => {
  const current = findOrderByTran(order.tran_id);
  if (!current || current.payment_status === "PAID") return;
  if (!["VALID", "VALIDATED"].includes(String(validation.status).toUpperCase())) return;
  if (Number(validation.amount) !== Number(current.amount) || String(validation.currency).toUpperCase() !== "BDT") {
    throw new Error("Gateway amount/currency mismatch");
  }
  db.prepare(`
    UPDATE orders SET payment_status='PAID', status='PROCESSING', val_id=?, bank_tran_id=?,
    gateway_response=?, updated_at=? WHERE id=?
  `).run(validation.val_id || null, validation.bank_tran_id || null, safeJson(validation), now(), current.id);
});

const markPaidWallet = db.transaction((tx, validation) => {
  const current = findWalletTxByTran(tx.tran_id);
  if (!current || current.status === "PAID") return;
  if (!["VALID", "VALIDATED"].includes(String(validation.status).toUpperCase())) return;
  if (Number(validation.amount) !== Number(current.amount) || String(validation.currency).toUpperCase() !== "BDT") {
    throw new Error("Gateway amount/currency mismatch");
  }

  db.prepare(`
    UPDATE wallet_transactions SET status='PAID',val_id=?,gateway_response=?,updated_at=? WHERE id=?
  `).run(validation.val_id || null, safeJson(validation), now(), current.id);

  db.prepare(`
    UPDATE wallets SET balance=balance+?,updated_at=? WHERE customer_phone=?
  `).run(current.amount, now(), current.customer_phone);
});

async function handleGatewayCallback(payload) {
  const tranId = String(payload.tran_id || "").trim();
  const valId = String(payload.val_id || "").trim();
  if (!tranId) return { ok: false, message: "Missing tran_id" };

  const order = findOrderByTran(tranId);
  const walletTx = findWalletTxByTran(tranId);
  if (!order && !walletTx) return { ok: false, message: "Unknown transaction" };

  let validation = payload;
  if (valId) {
    validation = await validateSsl(valId);
  }

  const status = String(validation.status || payload.status || "").toUpperCase();
  if (status === "VALID" || status === "VALIDATED") {
    if (order) markPaidOrder(order, validation);
    else markPaidWallet(walletTx, validation);
    return { ok: true, status: "PAID" };
  }

  const newStatus = status === "CANCELLED" || status === "CANCELED" ? "CANCELLED" : "FAILED";
  if (order) {
    db.prepare("UPDATE orders SET status=?,payment_status='FAILED',gateway_response=?,updated_at=? WHERE tran_id=?")
      .run(newStatus, safeJson(validation), now(), tranId);
  } else {
    db.prepare("UPDATE wallet_transactions SET status=?,gateway_response=?,updated_at=? WHERE tran_id=?")
      .run(newStatus, safeJson(validation), now(), tranId);
  }
  return { ok: true, status: newStatus };
}

app.all("/payment/success", async (req, res) => {
  try {
    await handleGatewayCallback(req.body || req.query || {});
    res.redirect("/?payment=success");
  } catch (e) {
    console.error(e);
    res.redirect("/?payment=error");
  }
});
app.all("/payment/fail", async (req, res) => {
  try { await handleGatewayCallback(req.body || req.query || {}); } catch {}
  res.redirect("/?payment=failed");
});
app.all("/payment/cancel", async (req, res) => {
  try { await handleGatewayCallback(req.body || req.query || {}); } catch {}
  res.redirect("/?payment=cancelled");
});
app.post("/payment/ipn", async (req, res) => {
  try {
    const result = await handleGatewayCallback(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

app.get("/api/order/:id", (req, res) => {
  const row = db.prepare(`
    SELECT id,product,package_name,uid,amount,status,payment_status,tran_id,created_at,updated_at
    FROM orders WHERE id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Order not found" });
  res.json(row);
});

app.get("/api/wallet", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "phone is required" });
  const row = db.prepare("SELECT customer_phone,balance,updated_at FROM wallets WHERE customer_phone=?").get(phone);
  res.json(row || { customer_phone: phone, balance: 0 });
});

app.get("/api/admin/orders", adminOnly, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200").all();
  res.json(rows);
});

app.post("/api/admin/order/:id/status", adminOnly, (req, res) => {
  const allowed = new Set(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "REFUNDED", "CANCELLED"]);
  const status = String(req.body.status || "").toUpperCase();
  if (!allowed.has(status)) return res.status(400).json({ error: "Invalid status" });
  const result = db.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=?").run(status, now(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Order not found" });
  res.json({ ok: true });
});

app.get("/api/admin/wallet-transactions", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT 200").all());
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`RS Top Up running on ${BASE_URL}`);
  console.log(`Mode: ${IS_LIVE ? "LIVE" : "SANDBOX"}`);
});
