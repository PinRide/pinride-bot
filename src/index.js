const express = require("express");
const crypto = require("crypto");
const https = require("https");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  APP_SECRET,
  PORT = 3000,
} = process.env;

function extractCoords(url) {
  const patterns = [
    /@(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    /[?&]q=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    /[?&]ll=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    /\/place\/[^@]+@(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    /daddr=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
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

function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s]+/g;
  return text.match(urlRegex) || [];
}

function buildUberLink(lat, lng) {
  return `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${lat.toFixed(6)}&dropoff[longitude]=${lng.toFixed(6)}&dropoff[nickname]=Destination`;
}

function sendWhatsAppMessage(to, text, callback) {
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });

  const options = {
    hostname: "graph.facebook.com",
    path: `/v19.0/${PHONE_NUMBER_ID}/messages`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => { if (callback) callback(null, data); });
  });
  req.on("error", (e) => { if (callback) callback(e); });
  req.write(body);
  req.end();
}

function resolveShortLink(url, callback) {
  try {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "HEAD",
    };
    const req = https.request(options, (res) => {
      const location = res.headers.location;
      callback(null, location || url);
    });
    req.on("error", () => callback(null, url));
    req.setTimeout(5000, () => { req.destroy(); callback(null, url); });
    req.end();
  } catch (e) {
    callback(null, url);
  }
}

function handleMessage(from, text) {
  if (!text) return;

  const greetings = ["hi", "hello", "hey", "start", "help", "/start"];
  if (greetings.includes(text.toLowerCase().trim())) {
    sendWhatsAppMessage(from,
      "👋 Hi! I'm the *Maps → Uber* bot.\n\nForward me any Google Maps link and I'll instantly send you an Uber link that opens directly at that location — no searching, no typing.\n\nJust paste a Google Maps URL to get started! 📍"
    );
    return;
  }

  const urls = extractUrls(text);
  const mapsUrls = urls.filter(u =>
    u.includes("maps.google") ||
    u.includes("google.com/maps") ||
    u.includes("maps.app.goo.gl") ||
    u.includes("goo.gl/maps")
  );

  if (mapsUrls.length === 0) {
    sendWhatsAppMessage(from,
      "❓ I didn't spot a Google Maps link in that message.\n\nForward me a Google Maps link and I'll convert it to an Uber link!"
    );
    return;
  }

  const mapUrl = mapsUrls[0];
  const isShort = mapUrl.includes("goo.gl") || mapUrl.includes("maps.app.goo.gl");

  if (isShort) {
    sendWhatsAppMessage(from, "🔗 Resolving link...");
    resolveShortLink(mapUrl, (err, resolved) => {
      const coords = extractCoords(resolved || mapUrl);
      if (!coords) {
        sendWhatsAppMessage(from, "⚠️ Couldn't extract coordinates. Try copying the full Google Maps URL from your browser.");
        return;
      }
      const link = buildUberLink(coords.lat, coords.lng);
      sendWhatsAppMessage(from,
        `✅ Got it! Here's your Uber link:\n\n${link}\n\n📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}\n\n_Tap the link to open Uber with this destination pre-filled._`
      );
    });
    return;
  }

  const coords = extractCoords(mapUrl);
  if (!coords) {
    sendWhatsAppMessage(from, "⚠️ Found a Maps link but couldn't extract coordinates. Try sharing the full URL from Google Maps.");
    return;
  }

  const link = buildUberLink(coords.lat, coords.lng);
  sendWhatsAppMessage(from,
    `✅ Got it! Here's your Uber link:\n\n${link}\n\n📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}\n\n_Tap the link to open Uber with this destination pre-filled._`
  );
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value || !value.messages) continue;
        for (const message of value.messages) {
          if (message.type === "location") {
            const { latitude, longitude } = message.location;
            const link = buildUberLink(latitude, longitude);
            sendWhatsAppMessage(message.from,
              `✅ Got your location pin!\n\n${link}\n\n📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
            );
          } else if (message.type === "text") {
            handleMessage(message.from, message.text && message.text.body);
          }
        }
      }
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", bot: "maps-to-uber" }));

app.listen(PORT, () => {
  console.log(`🚀 Maps-Uber bot running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: POST /webhook`);
});
