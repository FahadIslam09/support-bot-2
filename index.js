require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { db } = require('./src/db/db');
const { businessConfig, products } = require('./src/db/schema');
const { ChatService } = require('./src/services/chatService');

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

async function fetchImageAsBase64(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const base64 = Buffer.from(response.data, 'binary').toString('base64');
  const mimeType = response.headers['content-type'] || 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}

async function sendFacebookMessage(psid, pageId, text) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
  await axios.post(url, {
    recipient: { id: psid },
    message: { text },
  });
}

const messageBuffer = new Map();

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);

  res.status(200).send('EVENT_RECEIVED');

  for (const entry of body.entry) {
    const pageId = entry.id;
    for (const webhookEvent of entry.messaging) {
      if (webhookEvent.message) {
        const psid = webhookEvent.sender.id;
        const msg = webhookEvent.message;

        let buffer = messageBuffer.get(psid);
        if (!buffer) {
          buffer = { events: [], timer: null };
          messageBuffer.set(psid, buffer);
        }

        buffer.events.push(msg);
        if (buffer.timer) clearTimeout(buffer.timer);

        buffer.timer = setTimeout(() => processBufferedMessages(psid, pageId), 2500);
      }
    }
  }
});

async function processBufferedMessages(psid, pageId) {
  const buffer = messageBuffer.get(psid);
  messageBuffer.delete(psid);
  if (!buffer || buffer.events.length === 0) return;

  try {
    const config = await db.select().from(businessConfig).limit(1);
    const storeConfig = config[0];
    if (!storeConfig || !storeConfig.aiEnabled) return;

    const customer = await ChatService.getOrCreateCustomer(pageId, psid);
    const conversation = await ChatService.getOrCreateConversation(customer.id);

    const userContents = [];
    let logContent = '';
    
    for (const msg of buffer.events) {
      if (msg.text) {
        userContents.push({ type: 'text', text: msg.text });
        logContent += msg.text + '\n';
      }
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.type === 'image') {
            const base64 = await fetchImageAsBase64(att.payload.url);
            userContents.push({
              type: 'image_url',
              image_url: { url: base64 }
            });
            logContent += `[Image: ${att.payload.url}]\n`;
          }
        }
      }
    }

    if (userContents.length === 0) return;
    await ChatService.logMessage(conversation.id, 'user', logContent.trim());

    const allProducts = await db.select().from(products);
    let inventoryTable = '| Name | Price | Sizes | Features | Active |\n|---|---|---|---|---|\n';
    for (const p of allProducts) {
      inventoryTable += `| ${p.name} | ${p.price} | ${p.sizes} | ${p.features} | ${p.isActive} |\n`;
    }

    const systemPrompt = `
## তোমার পরিচয়
${storeConfig?.systemPersona || 'তুমি একজন সেলস অ্যাসিস্ট্যান্ট।'}

## বর্তমান ইনভেন্টরি (স্টক)
${inventoryTable}

## স্টোর পলিসি
${storeConfig?.deliveryPolicy || ''}
${storeConfig?.paymentPolicy || ''}

## কাস্টমার আসলে যা করবে (কনভার্সেশন ফ্লো)
১. প্রোডাক্ট কনফার্ম করো → দাম ও বিশেষত্ব বলো
২. সাইজ/কালার জিজ্ঞেস করো (যদি প্রযোজ্য হয়)
৩. ডেলিভারি ঠিকানা জিজ্ঞেস করো (জেলা সহ, ডেলিভারি চার্জ ক্যালকুলেট করতে)
৪. মোট দাম (প্রোডাক্ট + ডেলিভারি) জানিয়ে অর্ডার কনফার্ম করো
৫. কাস্টমারকে ধন্যবাদ দাও ও ডেলিভারি টাইমলাইন জানাও

## ছবি বিশ্লেষণের নিয়ম (ইমেজ হ্যান্ডলিং)
১. কাস্টমার ছবি পাঠালে প্রথমে নিখুঁতভাবে শনাক্ত করো ছবিতে আসলে কী পণ্য আছে।
২. ছবির পণ্য যদি তোমার ইনভেন্টরির কোনো আইটেমের সাথে হুবহু মিলে যায় → এভেইলেবল জানাও, দাম বলো, এবং সাইজ/ঠিকানা জিজ্ঞেস করো।
৩. ছবির পণ্য যদি স্টকে না থাকে → কখনোই মিথ্যা ম্যাচ করবেবিধা করবে না। স্পষ্টভাবে বলো: "দুঃখিত ভাইয়া, এটি আমাদের স্টকে নেই 😔"
৪. ছবির ব্যাকগ্রাউন্ড নিয়ে কিছু বলবে না।

## যা কখনো করবে না (Strict Guardrails)
- ❌ মিথ্যা তথ্য দেবে না — দাম, স্টক, বা ডেলিভারি নিয়ে কোনো ভুল তথ্য দেবে না।
- ❌ ইনভেন্টরিতে নেই এমন কিছু "আছে" বলবে না।
- ❌ অসম্পূর্ণ প্রশ্ন (খুব গুরুত্বপূর্ণ): কাস্টমার যদি শুধু বলে "এটা আছে?", কিন্তু নির্দিষ্ট প্রোডাক্টের নাম না বলে বা ছবি না দেয়, তবে নিজে থেকে ধরে নেবে না।
- ❌ শপিং-এর বাইরের প্রশ্নের উত্তর দেবে না।
`.trim();

    const history = await ChatService.getRecentChatHistory(conversation.id);
    const apiMessages = [{ role: 'system', content: systemPrompt }];
    
    for (let i = 0; i < history.length - 1; i++) {
      apiMessages.push({ role: history[i].role, content: history[i].content });
    }
    apiMessages.push({ role: 'user', content: userContents });

    const completion = await openai.chat.completions.create({
      model: 'openai/gpt-4o-mini',
      messages: apiMessages,
    });

    const aiText = completion.choices[0].message.content;
    await ChatService.logMessage(conversation.id, 'model', aiText);
    await sendFacebookMessage(psid, pageId, aiText);

  } catch (err) {
    console.error('Error processing messages:', err);
  }
}

const crypto = require('crypto');
const { eq } = require('drizzle-orm');

app.get('/api/config', async (req, res) => {
  try {
    let config = await db.select().from(businessConfig).limit(1);
    if (config.length === 0) {
      const id = crypto.randomUUID();
      const defaultConf = {
        id,
        storeName: 'My Store',
        aiEnabled: true,
        systemPersona: 'আপনি একজন সাহায্যকারী কাস্টমার সাপোর্ট এজেন্ট।',
        deliveryPolicy: 'ডেলিভারি ৩-৫ দিনের মধ্যে সম্পন্ন হয়।',
        paymentPolicy: 'আমরা ক্যাশ অন ডেলিভারি (COD) গ্রহণ করি।'
      };
      await db.insert(businessConfig).values(defaultConf);
      config = [defaultConf];
    }
    res.json(config[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const { storeName, aiEnabled, systemPersona, deliveryPolicy, paymentPolicy } = req.body;
    let config = await db.select().from(businessConfig).limit(1);
    if (config.length > 0) {
      await db.update(businessConfig)
        .set({ storeName, aiEnabled, systemPersona, deliveryPolicy, paymentPolicy })
        .where(eq(businessConfig.id, config[0].id));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const allProducts = await db.select().from(products);
    res.json(allProducts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, price, sizes, features } = req.body;
    const newProduct = {
      id: crypto.randomUUID(),
      name,
      price,
      sizes,
      features,
      isActive: true
    };
    await db.insert(products).values(newProduct);
    res.json(newProduct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await db.delete(products).where(eq(products.id, req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server on ${port}`));
