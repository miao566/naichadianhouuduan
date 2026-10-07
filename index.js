const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const {
  init: initDB,
  Category,
  Product,
  Order,
  Config,
  DEFAULT_SPEC_OPTIONS,
  toPlainProduct,
  toPlainOrder,
} = require("./db");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// ---------- 管理员鉴权 ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "qiyi2024";
const ADMIN_TOKEN = crypto
  .createHash("sha256")
  .update(ADMIN_PASSWORD + "qiyi-admin-salt")
  .digest("hex");

function adminAuth(req, res, next) {
  if (req.headers["x-admin-token"] === ADMIN_TOKEN) return next();
  res.status(401).send({ code: 401, message: "未登录或登录已失效" });
}

// 获取小程序调用方的 openid（云托管注入的请求头）
function getOpenid(req) {
  if (req.headers["x-wx-source"]) {
    return req.headers["x-wx-openid"] || "";
  }
  return "";
}

// ---------- 首页：商店管理后台 ----------
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ================= 小程序端 API =================

// 获取菜单（分类 + 商品 + 规格选项）
app.get("/api/menu", async (req, res) => {
  const [categories, products, specCfg] = await Promise.all([
    Category.findAll({ where: { enabled: true }, order: [["sort", "ASC"]] }),
    Product.findAll({ where: { enabled: true }, order: [["sort", "ASC"]] }),
    Config.findByPk("specOptions"),
  ]);
  res.send({
    code: 0,
    data: {
      categories: categories.map((c) => c.toJSON()),
      products: products.map(toPlainProduct),
      specOptions: (specCfg && specCfg.value) || DEFAULT_SPEC_OPTIONS,
    },
  });
});

// 生成未被占用的4位支付备注码
async function genRemarkCode() {
  for (let i = 0; i < 20; i++) {
    let code = String(Math.floor(Math.random() * 10000));
    code = "0".repeat(4 - code.length) + code;
    const used = await Order.count({ where: { remarkCode: code, status: "待支付" } });
    if (!used) return code;
  }
  return String(Date.now()).slice(-4);
}

// 下单
app.post("/api/orders", async (req, res) => {
  const openid = getOpenid(req);
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const num = (v) => Math.round(Number(v || 0) * 100) / 100;

  if (!b.custom && items.length === 0) {
    return res.send({ code: 1, message: "订单商品为空" });
  }
  if (b.mode === "delivery" && !b.address) {
    return res.send({ code: 1, message: "外送订单缺少配送地址" });
  }

  const order = await Order.create({
    id: "QY" + Date.now(),
    openid,
    remarkCode: await genRemarkCode(),
    mode: b.mode || "pickup",
    note: b.note || "",
    address: b.mode === "delivery" ? b.address || "" : "",
    items,
    goodsTotal: num(b.goodsTotal),
    packFee: num(b.packFee),
    deliveryFee: num(b.deliveryFee),
    total: num(b.total),
    custom: !!b.custom,
    status: "待支付",
  });
  res.send({ code: 0, data: toPlainOrder(order) });
});

// 查询我的订单（按 openid）
app.get("/api/orders", async (req, res) => {
  const openid = getOpenid(req);
  if (!openid) return res.send({ code: 0, data: [] });
  const orders = await Order.findAll({
    where: { openid },
    order: [["createdAt", "DESC"]],
    limit: 100,
  });
  res.send({ code: 0, data: orders.map(toPlainOrder) });
});

// 查询单个订单
app.get("/api/orders/:id", async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).send({ code: 1, message: "订单不存在" });
  res.send({ code: 0, data: toPlainOrder(order) });
});

// 已付款确认：核对4位支付备注码
app.post("/api/orders/:id/confirm", async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).send({ code: 1, message: "订单不存在" });
  if (order.status !== "待支付") {
    return res.send({ code: 1, message: "订单当前状态：" + order.status });
  }
  const code = String((req.body && req.body.code) || "").trim();
  if (code !== order.remarkCode) {
    return res.send({ code: 1, message: "备注码不正确" });
  }
  order.status = "已支付·制作中";
  await order.save();
  res.send({ code: 0, data: toPlainOrder(order) });
});

// ================= 管理后台 API =================

// 登录
app.post("/api/admin/login", async (req, res) => {
  const password = (req.body && req.body.password) || "";
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).send({ code: 1, message: "密码错误" });
  }
  res.send({ code: 0, data: { token: ADMIN_TOKEN } });
});

// 经营概况
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const { Op } = require("sequelize");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [todayOrders, pendingOrders, makingOrders, todayRevenue] = await Promise.all([
    Order.count({ where: { createdAt: { [Op.gte]: today } } }),
    Order.count({ where: { status: "待支付" } }),
    Order.count({ where: { status: "已支付·制作中" } }),
    Order.sum("total", {
      where: { status: { [Op.ne]: "待支付" }, createdAt: { [Op.gte]: today } },
    }),
  ]);
  res.send({
    code: 0,
    data: {
      todayOrders,
      pendingOrders,
      makingOrders,
      todayRevenue: Number(todayRevenue || 0),
    },
  });
});

// ---- 订单管理 ----

// 订单列表（可选 status 筛选）
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  const orders = await Order.findAll({
    where,
    order: [["createdAt", "DESC"]],
    limit: 200,
  });
  res.send({ code: 0, data: orders.map(toPlainOrder) });
});

// 修改订单状态
app.patch("/api/admin/orders/:id", adminAuth, async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).send({ code: 1, message: "订单不存在" });
  const status = (req.body && req.body.status) || "";
  const allowed = ["待支付", "已支付·制作中", "制作完成", "已完成", "已取消"];
  if (!allowed.includes(status)) {
    return res.send({ code: 1, message: "非法状态：" + status });
  }
  order.status = status;
  await order.save();
  res.send({ code: 0, data: toPlainOrder(order) });
});

// ---- 分类管理 ----

app.get("/api/admin/categories", adminAuth, async (req, res) => {
  const list = await Category.findAll({ order: [["sort", "ASC"]] });
  res.send({ code: 0, data: list.map((c) => c.toJSON()) });
});

app.post("/api/admin/categories", adminAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.name) return res.send({ code: 1, message: "缺少 id 或 name" });
  if (await Category.findByPk(b.id)) {
    return res.send({ code: 1, message: "分类ID已存在" });
  }
  const c = await Category.create({
    id: b.id, name: b.name, sort: Number(b.sort || 0), enabled: b.enabled !== false,
  });
  res.send({ code: 0, data: c.toJSON() });
});

app.put("/api/admin/categories/:id", adminAuth, async (req, res) => {
  const c = await Category.findByPk(req.params.id);
  if (!c) return res.status(404).send({ code: 1, message: "分类不存在" });
  const b = req.body || {};
  if (b.name !== undefined) c.name = b.name;
  if (b.sort !== undefined) c.sort = Number(b.sort);
  if (b.enabled !== undefined) c.enabled = !!b.enabled;
  await c.save();
  res.send({ code: 0, data: c.toJSON() });
});

app.delete("/api/admin/categories/:id", adminAuth, async (req, res) => {
  const n = await Product.count({ where: { categoryId: req.params.id } });
  if (n > 0) return res.send({ code: 1, message: "该分类下还有 " + n + " 个商品，请先移除" });
  await Category.destroy({ where: { id: req.params.id } });
  res.send({ code: 0, data: null });
});

// ---- 商品管理 ----

app.get("/api/admin/products", adminAuth, async (req, res) => {
  const list = await Product.findAll({ order: [["sort", "ASC"]] });
  res.send({ code: 0, data: list.map(toPlainProduct) });
});

app.post("/api/admin/products", adminAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.send({ code: 1, message: "缺少商品名称" });
  const p = await Product.create({
    categoryId: b.categoryId || "test",
    name: b.name,
    emoji: b.emoji || "🧋",
    desc: b.desc || "",
    price: Number(b.price || 0),
    tag: b.tag || "",
    sort: Number(b.sort || 0),
    enabled: b.enabled !== false,
  });
  res.send({ code: 0, data: toPlainProduct(p) });
});

app.put("/api/admin/products/:id", adminAuth, async (req, res) => {
  const p = await Product.findByPk(req.params.id);
  if (!p) return res.status(404).send({ code: 1, message: "商品不存在" });
  const b = req.body || {};
  ["categoryId", "name", "emoji", "desc", "tag"].forEach((k) => {
    if (b[k] !== undefined) p[k] = b[k];
  });
  if (b.price !== undefined) p.price = Number(b.price);
  if (b.sort !== undefined) p.sort = Number(b.sort);
  if (b.enabled !== undefined) p.enabled = !!b.enabled;
  await p.save();
  res.send({ code: 0, data: toPlainProduct(p) });
});

app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  await Product.destroy({ where: { id: req.params.id } });
  res.send({ code: 0, data: null });
});

// ---- 规格选项管理 ----

app.get("/api/admin/specs", adminAuth, async (req, res) => {
  const cfg = await Config.findByPk("specOptions");
  res.send({ code: 0, data: (cfg && cfg.value) || DEFAULT_SPEC_OPTIONS });
});

app.put("/api/admin/specs", adminAuth, async (req, res) => {
  const value = req.body || {};
  const [cfg] = await Config.findOrCreate({
    where: { key: "specOptions" },
    defaults: { key: "specOptions", value: DEFAULT_SPEC_OPTIONS },
  });
  cfg.value = value;
  await cfg.save();
  res.send({ code: 0, data: value });
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("七页奶茶社后台启动成功，端口:", port);
  });
}

bootstrap();
