// server.js
const admin = require("firebase-admin");
const mqtt = require("mqtt");
const nodemailer = require("nodemailer");

// --------------------
// Firestore setup
// --------------------
admin.initializeApp({
  credential: admin.credential.cert(
    require("./studio-1400358527-eb8e5-firebase-adminsdk-fbsvc-2285702e52.json")
  ),
});
const db = admin.firestore();

// --------------------
// Email setup (hardcoded for now)
// --------------------
const EMAIL_USER = "nkhao23@clc.fitus.edu.vn";
const EMAIL_PASS = "krbmhidbkueqohjq";

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// --------------------
// MQTT setup
// --------------------
const MQTT_HOST = "a63c6d5a32cf4a67b9d6a209a8e13525.s1.eu.hivemq.cloud";
const MQTT_PORT = "8883";
const MQTT_USERNAME = "tmitmi";
const MQTT_PASSWORD = "Tm123456";

const MQTT_TOPIC_PREFIX = "autofeeder";
const MQTT_WILDCARD_TOPIC = `${MQTT_TOPIC_PREFIX}/+/+`;

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});

client.on("connect", () => {
  console.log("[MQTT Listener] Connected to broker");
  client.subscribe(MQTT_WILDCARD_TOPIC, (err) => {
    if (err) console.error("[MQTT Listener] Subscribe failed", err);
    else console.log(`[MQTT Listener] Subscribed to ${MQTT_WILDCARD_TOPIC}`);
  });
});

client.on("error", (err) => {
  console.error("[MQTT Listener] Connection error", err);
});

client.on("message", async (topic, message) => {
  const payload = message.toString();
  console.log(`[MQTT Listener] ${topic}: ${payload}`);

  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== MQTT_TOPIC_PREFIX) {
    console.warn(`Invalid topic ignored: ${topic}`);
    return;
  }

  const feederId = parts[1];
  const metric = parts[2];

  const feederRef = db.collection("feeders").doc(feederId);

  try {
    let updateData = {};
    switch (metric) {
      case "status":
        updateData = { status: payload };
        break;
      case "bowl":
        updateData = { bowlLevel: parseFloat(payload) };
        break;
      case "portion":
        updateData = { lastPortion: parseFloat(payload) };
        break;

      case "weight": {
        const weight = parseFloat(payload);
        updateData = { currentWeight: weight };

        if (weight <= 20.0) {
          await notifyUser(
            feederId,
            "Low Food Alert",
            "Your feeder is running low on food. Please refill it.",
            "lowFoodAlerts"
          );
        }
        break;
      }

      case "feed_completed": {
        const portionSize = parseFloat(payload);
        if (isNaN(portionSize)) return;

        await feederRef.collection("feedingLogs").add({
          portionSize,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          source: "device",
        });

        await notifyUser(
          feederId,
          "Pet Feeding Completed",
          `Your pet was fed ${portionSize} grams.`,
          "feedingReminders"
        );

        return;
      }

      case "feed_failed": {
        const portionSize = parseFloat(payload) || 0;

        await feederRef.collection("feedingLogs").add({
          portionSize,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          source: "device",
          status: "failed",
        });

        await notifyUser(
          feederId,
          "Pet Feeding Failed",
          `A scheduled feeding of ${portionSize} grams could not be completed. Please check your feeder.`,
          "feedingReminders"
        );

        console.log(
          `Feeding failure logged for feeder ${feederId}: ${portionSize}`
        );
        return;
      }

      case "cmd":
        return; // ignore outgoing commands
      default:
        console.warn(`Unknown metric for feeder ${feederId}: ${metric}`);
        return;
    }
    await feederRef.set(updateData, { merge: true });
    console.log(`Firestore updated for feeder ${feederId}`, updateData);
  } catch (err) {
    console.error(`Failed to update Firestore for feeder ${feederId}`, err);
  }
});

// --------------------
// Scheduled Feeder Commands
// --------------------
const CHECK_INTERVAL = 10000; // 10 seconds, adjust as needed

async function checkAndSendFeedingCommands() {
  const now = new Date();

  try {
    // Fetch schedules due now or earlier, and not yet sent
    const snapshot = await db
      .collectionGroup("feedingSchedules")
      .where("scheduledTime", "<=", now)
      .where("sent", "==", false)
      .get();

    for (const doc of snapshot.docs) {
      const feederDocRef = doc.ref.parent.parent; // feeders/{feederId}
      if (!feederDocRef) continue;

      const feederId = feederDocRef.id;
      const scheduleData = doc.data();

      // Example command: send portion size
      // const commandPayload = JSON.stringify({
      //   portion: scheduleData.portionSize,
      // });

      const commandPayload = "feed";

      client.publish(`autofeeder/${feederId}/cmd`, commandPayload, (err) => {
        if (err) {
          console.error(`Failed to publish cmd for feeder ${feederId}:`, err);
        } else {
          console.log(
            `Command published for feeder ${feederId}:`,
            commandPayload
          );
        }
      });

      // Mark schedule as sent
      await doc.ref.update({ sent: true });
    }
  } catch (err) {
    console.error("Error checking feeding schedules:", err);
  }
}

// --------------------
// Notify helper function
// --------------------
async function notifyUser(feederId, subject, text, settingsKey) {
  const snapshot = await db
    .collection("users")
    .where("feederId", "==", feederId)
    .get();

  if (snapshot.empty) return;

  for (const doc of snapshot.docs) {
    const user = doc.data();
    if (!user.settings?.[settingsKey]) continue;

    try {
      await mailer.sendMail({
        from: EMAIL_USER,
        to: user.email,
        subject,
        text,
      });
      console.log(`Email sent to ${user.email}: ${subject}`);
    } catch (err) {
      console.error(`Failed to send email to ${user.email}:`, err);
    }
  }
}

// Start the interval loop
setInterval(checkAndSendFeedingCommands, CHECK_INTERVAL);

// --------------------
// Optional HTTP keep-alive (e.g., health check)
// --------------------
const express = require("express");
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.send("MQTT listener active");
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
