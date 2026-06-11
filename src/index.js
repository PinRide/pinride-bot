const express = require("express");
const https = require("https");

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

console.log("Starting PinRide bot...");
console.log("PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? "set" : "MISSING");
console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "set" : "MISSING");
console.log("VERIFY_TOKEN:", VERIFY_TOKEN ? "set" : "MISSING");

function extractCoords(url) {
  const patterns = [
    /@(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    /[?&]q=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    /[?&]ll=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

function sendMessage(to, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text }
    });

    const options = {
      hostname: "graph.facebook.com",
      path: `/v19.0/${PHONE_NUMBER_ID}/messages`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        console.log("WhatsApp API response:", data);
        resolve(data);
      });
    });

    req.on("error", (e) => {
      console.error("Request error:", e.message);
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log("Verify request - mode:", mode, "token match:", token === VERIFY_TOKEN);
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  console.log("POST /webhook received");
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("Body:", JSON.stringify(body));

    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      console.log("No message found in payload");
      return;
    }

    const from = message.from;
    const text = message.text?.body || "";
    console.log("From:", from, "Text:", text);

    const urls = text.match(/https?:\/\/[^\s]+/g) || [];
    const mapsUrl = urls.find(u =>
      u.includes("google.com/maps") ||
      u.includes("maps.app.goo.gl") ||
      u.includes("goo.gl/maps")
    );

    if (!mapsUrl) {
      sendMessage(from, "Hi! Send me a Google Maps link and I'll convert it to an Uber link 🚗").catch(console.error);
      return;
    }

    const coords = extractCoords(mapsUrl);
    if (!coords) {
      sendMessage(from, "⚠️ Found a Maps link but couldn't read the coordinates. Try opening Google Maps, dropping a pin, and sharing that link.").catch(console.error);
      return;
    }

    const uberLink = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${coords.lat.toFixed(6)}&dropoff[longitude]=${coords.lng.toFixed(6)}&dropoff[nickname]=Destination`;

    sendMessage(from, `✅ Here's your Uber link:\n\n${uberLink}\n\n📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}\n\nTap to open Uber with this destination! 🚗`).catch(console.error);

  } catch (err) {
    console.error("Webhook handler error:", err.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: "pinride" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PinRide bot running on port ${PORT}`);
});
