const express = require("express");
const https = require("https");
const http = require("http");

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
  // IMPORTANT: order matters. The !3d/!4d pair is the actual PIN marker
  // location. The @lat,lng pair is just the map VIEWPORT center, which can
  // drift to a nearby road/building and is NOT reliable for an exact pin.
  // Always try the precise pin pattern first.
  const patterns = [
    /!3d(-?\d+\.?\d+)!4d(-?\d+\.?\d+)/,        // precise pin marker (preferred)
    /[?&]q=(-?\d+\.?\d+),(-?\d+\.?\d+)/,        // explicit query coords
    /[?&]ll=(-?\d+\.?\d+),(-?\d+\.?\d+)/,       // explicit ll param
    /\/place\/[^@]+@(-?\d+\.?\d+),(-?\d+\.?\d+)/, // place url fallback
    /@(-?\d+\.?\d+),(-?\d+\.?\d+)/,             // viewport center (last resort, least precise)
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

function resolveRedirect(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, { method: "HEAD" }, (res) => {
      const location = res.headers["location"];
      if (location) {
        console.log("Redirected to:", location);
        if (location.includes("google.com/maps")) {
          resolve(location);
        } else {
          resolveRedirect(location).then(resolve);
        }
      } else {
        resolve(url);
      }
    });
    req.on("error", () => resolve(url));
    req.setTimeout(6000, () => { req.destroy(); resolve(url); });
    req.end();
  });
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

async function processMapLink(from, mapsUrl) {
  const isShort = mapsUrl.includes("goo.gl") || mapsUrl.includes("maps.app");

  let fullUrl = mapsUrl;
  if (isShort) {
    console.log("Resolving short link:", mapsUrl);
    await sendMessage(from, "🔗 Resolving link...");
    fullUrl = await resolveRedirect(mapsUrl);
    console.log("Resolved to:", fullUrl);
  }

  const coords = extractCoords(fullUrl);
  if (!coords) {
    await sendMessage(from, "⚠️ Couldn't read the coordinates from that link.\n\nTry this: open Google Maps → long press on the exact location → tap the coordinates that appear at the top → Share → Copy link. Then paste it here!");
    return;
  }

  const uberLink = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${coords.lat.toFixed(6)}&dropoff[longitude]=${coords.lng.toFixed(6)}&dropoff[nickname]=Destination`;

  await sendMessage(from, `✅ Here's your Uber link:\n\n${uberLink}\n\n📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}\n\nTap to open Uber with this destination! 🚗`);
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
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
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;

    if (message.type === "location") {
      const { latitude, longitude } = message.location;
      const uberLink = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${latitude.toFixed(6)}&dropoff[longitude]=${longitude.toFixed(6)}&dropoff[nickname]=Destination`;
      sendMessage(from, `✅ Here's your Uber link:\n\n${uberLink}\n\n📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}\n\nTap to open Uber with this destination! 🚗`).catch(console.error);
      return;
    }

    const text = message.text?.body || "";
    console.log("From:", from, "Text:", text);

    const greetings = ["hi", "hello", "hey", "help", "/start"];
    if (greetings.includes(text.toLowerCase().trim())) {
      sendMessage(from, "👋 Hi! I'm *PinRide*.\n\nSend me any Google Maps link and I'll instantly convert it to an Uber link — no searching, no typing.\n\nJust paste or forward a Google Maps URL to get started! 📍").catch(console.error);
      return;
    }

    const urls = text.match(/https?:\/\/[^\s]+/g) || [];
    const mapsUrl = urls.find(u =>
      u.includes("google.com/maps") ||
      u.includes("maps.app.goo.gl") ||
      u.includes("goo.gl/maps")
    );

    if (!mapsUrl) {
      sendMessage(from, "❓ I didn't spot a Google Maps link.\n\nForward me a Google Maps link and I'll convert it to an Uber link! 📍").catch(console.error);
      return;
    }

    processMapLink(from, mapsUrl).catch(console.error);

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: "pinride" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PinRide bot running on port ${PORT}`);
});
