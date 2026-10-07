const { Sequelize, DataTypes } = require("sequelize");

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const [host, port] = MYSQL_ADDRESS.split(":");

const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: "mysql" /* one of 'mysql' | 'mariadb' | 'postgres' | 'mssql' */,
  logging: false,
});

// ---- 分类 ----
const Category = sequelize.define("Category", {
  id: { type: DataTypes.STRING(32), primaryKey: true },
  name: { type: DataTypes.STRING(64), allowNull: false },
  sort: { type: DataTypes.INTEGER, defaultValue: 0 },
  enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: "shop_categories" });

// ---- 商品 ----
const Product = sequelize.define("Product", {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  categoryId: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "test" },
  name: { type: DataTypes.STRING(128), allowNull: false },
  emoji: { type: DataTypes.STRING(16), defaultValue: "🧋" },
  desc: { type: DataTypes.STRING(255), defaultValue: "" },
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  tag: { type: DataTypes.STRING(32), defaultValue: "" },
  sort: { type: DataTypes.INTEGER, defaultValue: 0 },
  enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: "shop_products" });

// ---- 订单 ----
const Order = sequelize.define("Order", {
  id: { type: DataTypes.STRING(32), primaryKey: true },
  openid: { type: DataTypes.STRING(64), defaultValue: "" },
  remarkCode: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "" },
  mode: { type: DataTypes.STRING(16), defaultValue: "pickup" }, // pickup / delivery / custom
  note: { type: DataTypes.STRING(255), defaultValue: "" },
  address: { type: DataTypes.STRING(255), defaultValue: "" },
  items: { type: DataTypes.JSON, defaultValue: [] },
  goodsTotal: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  packFee: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  deliveryFee: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: "待支付" },
  custom: { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: "shop_orders" });

// ---- 配置（规格选项等）----
const Config = sequelize.define("Config", {
  key: { type: DataTypes.STRING(64), primaryKey: true },
  value: { type: DataTypes.JSON },
}, { tableName: "shop_config" });

// 默认规格选项（与小程序原 utils/menu.js 保持一致）
const DEFAULT_SPEC_OPTIONS = {
  cup: [
    { name: "中杯", extra: 0 },
    { name: "大杯", extra: 3 }
  ],
  sugar: ["无糖", "三分糖", "五分糖", "七分糖", "正常糖"],
  ice: ["热饮", "去冰", "少冰", "正常冰"],
  toppings: [
    { name: "珍珠", extra: 2 },
    { name: "椰果", extra: 2 },
    { name: "布丁", extra: 3 },
    { name: "芋圆", extra: 3 }
  ]
};

function toPlainProduct(p) {
  const o = p.toJSON();
  o.price = Number(o.price);
  return o;
}

function toPlainOrder(o) {
  const d = o.toJSON();
  ["goodsTotal", "packFee", "deliveryFee", "total"].forEach((k) => {
    d[k] = Number(d[k] || 0);
  });
  return d;
}

// 数据库初始化方法（含默认数据写入）
async function init() {
  await Category.sync({ alter: true });
  await Product.sync({ alter: true });
  await Order.sync({ alter: true });
  await Config.sync({ alter: true });

  // 首次部署：写入默认菜单
  const catCount = await Category.count();
  if (catCount === 0) {
    await Category.create({ id: "hot", name: "热销", sort: 1 });
    await Category.create({ id: "test", name: "测试", sort: 2 });
    await Product.create({
      categoryId: "test", name: "测试商品", emoji: "🧋",
      desc: "支付流程测试，每单 0.01 元", price: 0.01, tag: "测试", sort: 1
    });
  }

  // 首次部署：写入默认规格选项
  await Config.findOrCreate({
    where: { key: "specOptions" },
    defaults: { key: "specOptions", value: DEFAULT_SPEC_OPTIONS },
  });
}

// 导出初始化方法和模型
module.exports = {
  init,
  Category,
  Product,
  Order,
  Config,
  DEFAULT_SPEC_OPTIONS,
  toPlainProduct,
  toPlainOrder,
};
