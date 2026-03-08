const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const cron = require("node-cron");
require("dotenv").config({ debug: true });

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.PORT),
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("✅ DB connected"))
  .catch((err) => console.error("❌ DB error", err));

bot.onText(/\/checkin/, async (msg) => {
  const userId = msg.from.id;
  const now = new Date();
  const username =
    msg.from.username ||
    `${msg.from.first_name ? msg.from.first_name + " " : ""}${msg.from.last_name || ""}`;

  const active = await pool.query(
    "SELECT * FROM work_sessions WHERE user_id=$1 AND checkout_time IS NULL",
    [userId],
  );

  if (active.rows.length > 0) {
    bot.sendMessage(msg.chat.id, "❌ You already checked in.");
    return;
  }

  await pool.query(
    "INSERT INTO work_sessions (user_id, username, checkin_time) VALUES ($1,$2,$3)",
    [userId, username, now],
  );

  const checkoutTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  bot.sendMessage(
    msg.chat.id,
    `✅ You checked in at ${now.toLocaleTimeString()}
Checkout after: ${checkoutTime.toLocaleTimeString()}`,
  );
});

bot.onText(/\/checkout/, async (msg) => {
  const userId = msg.from.id;
  const now = new Date();

  const result = await pool.query(
    "SELECT * FROM work_sessions WHERE user_id=$1 AND checkout_time IS NULL",
    [userId],
  );

  if (result.rows.length === 0) {
    bot.sendMessage(msg.chat.id, "❌ You haven't checked in.");
    return;
  }

  const checkin = result.rows[0].checkin_time;
  const diff = now - new Date(checkin);

  const required = 9 * 60 * 60 * 1000;

  if (diff < required) {
    const remain = required - diff;
    bot.sendMessage(
      msg.chat.id,
      `❌ Cannot checkout yet. ${formatDuration(remain)} remaining.`,
    );
    return;
  }

  await pool.query("UPDATE work_sessions SET checkout_time=$1 WHERE id=$2", [
    now,
    result.rows[0].id,
  ]);

  bot.sendMessage(msg.chat.id, "✅ Checkout successful!");
});

bot.onText(/\/status/, async (msg) => {
  const userId = msg.from.id;

  const result = await pool.query(
    "SELECT * FROM work_sessions WHERE user_id=$1 AND checkout_time IS NULL",
    [userId],
  );

  if (result.rows.length === 0) {
    bot.sendMessage(msg.chat.id, "You haven't checked in.");
    return;
  }

  const checkin = result.rows[0].checkin_time;
  const diff = new Date() - new Date(checkin);

  bot.sendMessage(msg.chat.id, `You have worked ${formatDuration(diff)}`);
});

bot.onText(/\/help/, (msg) => {
  const helpMessage = `
📋 *Available Commands*

/checkin - Start work and record check-in time  
/checkout - Checkout after 9 hours  
/status - Show worked duration  
/help - Show this message
`;

  bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: "Markdown" });
});

function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

  const hourText = hours === 1 ? "hour" : "hours";
  const minText = minutes === 1 ? "min" : "mins";

  return `${hours} ${hourText} ${minutes} ${minText}`;
}

cron.schedule("* * * * *", async () => {
  const sessions = await pool.query(`
    SELECT * FROM work_sessions
    WHERE checkout_time IS NULL
    AND reminder_sent = false
  `);

  for (const session of sessions.rows) {
    const checkin = new Date(session.checkin_time);
    const now = new Date();

    const diff = now - checkin;
    const required = 9 * 60 * 60 * 1000;

    if (diff >= required) {
      await bot.sendMessage(session.user_id, "⏰ It's time to checkout!");

      await pool.query(
        "UPDATE work_sessions SET reminder_sent=true WHERE id=$1",
        [session.id],
      );
    }
  }
});
