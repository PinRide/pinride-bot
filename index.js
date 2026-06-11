import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,       // Meta permanent system user token
  VERIFY_TOKEN,         // Your own secret string for webhook verification
  PHONE_NUMBER_ID,      // WhatsApp Business phone number ID
  APP_SECRET,           // Meta app secret (for payload signature verification)
  PORT = 3000,
} = process.env;

// ─── Coordinate extraction ────────────────────────────────────────────────────
// Handles all common Google Maps URL formats
function extractCoords(url) {
  const patterns = [
    // @lat,lng (standard maps URL after navigation)
    /@(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    // ?q=lat,lng
    /[?&]q=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    // ?ll=lat,lng
    /[?&]ll=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    // /place/name/@lat,lng
    /\/place\/[^@]+@(-?\d+\.?\d+),(-?\d+\.?\d+)/,
    // daddr=lat,lng
    /daddr=(-?\d+\.?\d+),(-?\d+\.?\d+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

// Resolve a short link (goo.gl / maps.app.goo.gl) by following redirects
async function resolveShortLink(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      timeout: 5000,
    });
    return res.url;
  } catch {
    return null;
  }
}

// Extract all URLs from a message body
function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s]+/g;
  return text.match(urlRegex) || [];
}

// ─── Uber deep link builder ───────────────────────────────────────────────────
function buildUberLink(lat, lng, nickname = "Destination") {
  const params = new URLSearchParams({
    action: "setPickup",
    "pickup[0][latitude]": "",
    "pickup[0][longitude]": "",
    "dropoff[latitude]": lat.toFixed(6),
    "dropoff[longitude]": lng.toFixed(6),
    "dropoff[nickname]": nickname,
  });

  // Universal deep link — works on iOS, Android, and mobile web
  return `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${lat.toFixed(6)}&dropoff[longitude]=${lng.toFixed(6)}&dropoff[nickname]=${encodeURIComponent(nickname)}`;
}

// ─── WhatsApp Cloud API sender ────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    console.error("WhatsApp send error:", JSON.stringify(err));
  }

  return res.ok;
}

// ─── Core bot logic ───────────────────────────────────────────────────────────
async function handleIncomingMessage(from, messageBody) {
  const text = messageBody?.trim();
  if (!text) return;

  console.log(`📩 Message from ${from}: ${text.substring(0, 80)}`);

  // Greeting detection
  const greetings = ["hi", "hello", "hey", "start", "help", "/start"];
  if (greetings.includes(text.toLowerCase())) {
    await sendWhatsAppMessage(
      from,
      `👋 Hi! I'm the *Maps → Uber* bot.\n\nForward me any Google Maps link and I'll instantly send you an Uber link that opens directly at that location — no searching, no typing.\n\nJust paste or forward a Google Maps URL to get started! 📍`
    );
    return;
  }

  // Find URLs in the message
  const urls = extractUrls(text);
  const mapsUrls = urls.filter(
    (u) =>
      u.includes("maps.google") ||
      u.includes("google.com/maps") ||
      u.includes("maps.app.goo.gl") ||
      u.includes("goo.gl/maps")
  );

  if (mapsUrls.length === 0) {
    await sendWhatsAppMessage(
      from,
      `❓ I didn't spot a Google Maps link in that message.\n\nForward me a Google Maps link and I'll convert it to an Uber link. You can get a Maps link by:\n1. Open Google Maps\n2. Long-press on any location\n3. Tap *Share* → copy the link\n4. Paste it here`
    );
    return;
  }

  // Process the first Maps URL found
  let mapUrl = mapsUrls[0];

  // Resolve short links
  const isShortLink =
    mapUrl.includes("goo.gl") || mapUrl.includes("maps.app.goo.gl");

  if (isShortLink) {
    await sendWhatsAppMessage(from, `🔗 Resolving link...`);
    const resolved = await resolveShortLink(mapUrl);
    if (resolved) {
      mapUrl = resolved;
      console.log(`Resolved to: ${mapUrl}`);
    } else {
      await sendWhatsAppMessage(
        from,
        `⚠️ Couldn't resolve that short link. Try opening Google Maps, copying the full URL from the address bar, and sending that instead.`
      );
      return;
    }
  }

  const coords = extractCoords(mapUrl);

  if (!coords) {
    await sendWhatsAppMessage(
      from,
      `⚠️ I found a Maps link but couldn't extract the exact coordinates.\n\nTry this: open the location in Google Maps → tap the pin → the coordinates will appear at the top of the screen. Copy and send me just those numbers (e.g. *25.197, 55.274*) and I'll build the Uber link.`
    );
    return;
  }

  const uberLink = buildUberLink(coords.lat, coords.lng);

  await sendWhatsAppMessage(
    from,
    `✅ Got it! Here's your Uber link:\n\n${uberLink}\n\n📍 Coordinates: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}\n\n_Tap the link on your phone to open Uber with this destination pre-filled._`
  );

  console.log(
    `✅ Sent Uber link to ${from} for coords ${coords.lat}, ${coords.lng}`
  );
}

// ─── Webhook verification (GET) ───────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ─── Webhook payload (POST) ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Verify payload signature
  const signature = req.headers["x-hub-signature-256"];
  if (APP_SECRET && signature) {
    const expectedSig =
      "sha256=" +
      crypto
        .createHmac("sha256", APP_SECRET)
        .update(JSON.stringify(req.body))
        .digest("hex");
    if (signature !== expectedSig) {
      console.warn("❌ Invalid signature — ignoring payload");
      return res.sendStatus(403);
    }
  }

  // Always respond 200 immediately (Meta requires < 5s)
  res.sendStatus(200);

  // Process asynchronously
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          if (message.type !== "text") {
            // Handle location pins shared natively from WhatsApp
            if (message.type === "location") {
              const { latitude, longitude } = message.location;
              const uberLink = buildUberLink(latitude, longitude, "Shared pin");
              await sendWhatsAppMessage(
                message.from,
                `✅ Got your location pin! Here's your Uber link:\n\n${uberLink}\n\n📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
              );
              continue;
            }
            continue;
          }

          await handleIncomingMessage(message.from, message.text?.body);
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", bot: "maps-to-uber" }));

app.listen(PORT, () => {
  console.log(`🚀 Maps→Uber bot running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: POST /webhook`);
});
