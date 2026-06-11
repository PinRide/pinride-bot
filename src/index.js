const express = require("express");
const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

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

async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { body: text }
  };
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    console.log("Send result:", JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("Send error:", err.message);
  }
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log("Webhook verify:", mode, token);
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  console.log("Webhook received:", JSON.stringify(req.body));
  
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    
    if (!message) return;
    
    const from = message.from;
    const text = message.text?.body || "";
    
    console.log("Message from:", from, "text:", text);
    
    const urls = text.match(/https?:\/\/[^\s]+/g) || [];
    const mapsUrl = urls.find(u => u.includes("google.com/maps") || u.includes("maps.app.goo.gl"));
    
    if (!mapsUrl) {
      await sendMessage(from, "Hi! Send me a Google Maps link and I'll convert it to an Uber link instantly 🚗");
      return;
    }
    
    const coords = extractCoords(mapsUrl);
    if (!coords) {
      await sendMessage(from, "⚠️ Found a Maps link but couldn't extract coordinates. Try sharing a pin directly from Google Maps.");
      return;
    }
    
    const uberLink = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${coords.lat.toFixed(6)}&dropoff[longitude]=${coords.lng.toFixed(6)}&dropoff[nickname]=Destination`;
    
    await sendMessage(from, `✅ Here's your Uber link:\n\n${uberLink}\n\n📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}\n\nTap the link to open Uber with this destination! 🚗`);
    
  } catch (err) {
    console.error("Error:", err.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: "pinride" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PinRide bot running on port ${PORT}`);
});
