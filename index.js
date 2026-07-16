require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { db } = require('./src/db/db');
const { businessConfig, products } = require('./src/db/schema');
const { ChatService } = require('./src/services/chatService');

const app = express();
app.use(express.json());
app.use(express.static('public'));
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: process.env.GEMINI_API_KEY,
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
        if (webhookEvent.message.is_echo) continue;
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

async function sendTypingIndicator(psid, pageId) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
  await axios.post(url, { recipient: { id: psid }, sender_action: 'typing_on' }).catch(() => {});
}

const rateLimits = new Map();

async function processBufferedMessages(psid, pageId) {
  const buffer = messageBuffer.get(psid);
  messageBuffer.delete(psid);
  if (!buffer || buffer.events.length === 0) return;

  const now = Date.now();
  let rateData = rateLimits.get(psid) || { count: 0, firstReq: now };
  if (now - rateData.firstReq > 60000) {
    rateData = { count: 1, firstReq: now };
  } else {
    rateData.count++;
  }
  rateLimits.set(psid, rateData);

  if (rateData.count > 15) {
    console.warn(`Rate limit exceeded for PSID: ${psid}`);
    return;
  }

  try {
    const config = await db.select().from(businessConfig).limit(1);
    const storeConfig = config[0];
    if (!storeConfig || !storeConfig.aiEnabled) return;

    await sendTypingIndicator(psid, pageId);

    const customer = await ChatService.getOrCreateCustomer(pageId, psid);
    const conversation = await ChatService.getOrCreateConversation(customer.id);
    const isNewCustomer = customer._isNew || false;

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

    const customerContext = isNewCustomer
      ? 'এটি নতুন কাস্টমার। প্রথমে উষ্ণভাবে স্বাগত জানাও, স্টোর সম্পর্কে ১ লাইনে বলো, এবং কীভাবে সাহায্য করতে পারো জিজ্ঞেস করো।'
      : 'এটি পুরনো কাস্টমার। সরাসরি সাহায্য করো, আবার পরিচয় দেওয়ার দরকার নেই।';

    const systemPrompt = `
## তোমার পরিচয়
তুমি ${storeConfig?.botName || 'AI Assistant'}, ${storeConfig?.storeName || 'এই স্টোর'}-এর সেলস অ্যাসিস্ট্যান্ট।
${storeConfig?.systemPersona || 'তুমি একজন সেলস অ্যাসিস্ট্যান্ট।'}

## টোন ও ব্যক্তিত্ব (Bangladesh Market)
- তুমি বন্ধুসুলভ, আন্তরিক, এবং professional — যেন একজন অভিজ্ঞ বাংলাদেশি বিক্রেতা কথা বলছে।
- ইমোজি ব্যবহার করো (কিন্তু অতিরিক্ত নয়, প্রতি মেসেজে ১-২টি)।
- কাস্টমারকে "ভাইয়া" বা "আপু" বলো (casual but respectful)।
- দামের ক্ষেত্রে সবসময় "টাকা" বা "Tk" বলবে (যেমন: "৳১৯৯" বা "১৯৯ টাকা")।
- উৎসাহী এবং আত্মবিশ্বাসী থাকো, কিন্তু pushy হয়ো না।

## রেসপন্স ফরম্যাট
- প্রতিটি রেসপন্স সর্বোচ্চ ৩-৪ লাইন রাখো। Messenger-এ বড় প্যারাগ্রাফ কেউ পড়ে না।
- একবারে একটি প্রশ্ন করো, একসাথে অনেকগুলো না।
- দাম বলার সময় সংক্ষেপে বলো, লম্বা বর্ণনা দিও না।

## কাস্টমার কনটেক্সট
${customerContext}

## বর্তমান ইনভেন্টরি (স্টক)
${inventoryTable}

## স্টোর পলিসি
${storeConfig?.deliveryPolicy || ''}
${storeConfig?.paymentPolicy || ''}

## ডেলিভারি চার্জ
- মূল শহর (${storeConfig?.baseCity || 'Rajshahi'})-এর ভেতরে ডেলিভারি চার্জ ${storeConfig?.insideCityCharge || '60'} টাকা।
- ${storeConfig?.baseCity || 'Rajshahi'}-এর বাইরে যেকোনো জেলায় ডেলিভারি চার্জ ${storeConfig?.outsideCityCharge || '120'} টাকা।
- কাস্টমার ঠিকানা দিলে এই চার্জগুলোর ওপর ভিত্তি করে মোট দাম (Total Price) জানিয়ে দেবে।

## কাস্টমার আসলে যা করবে (কনভার্সেশন ফ্লো)
১. প্রোডাক্ট কনফার্ম করো → দাম ও বিশেষত্ব বলো
২. সাইজ/কালার জিজ্ঞেস করো (যদি প্রযোজ্য হয়)
৩. ডেলিভারি ঠিকানা জিজ্ঞেস করো (জেলা সহ, ডেলিভারি চার্জ ক্যালকুলেট করতে)
৪. মোট দাম (প্রোডাক্ট + ডেলিভারি) জানিয়ে অর্ডার কনফার্ম করো
৫. কাস্টমারকে ধন্যবাদ দাও ও ডেলিভারি টাইমলাইন জানাও

## প্রোডাক্ট রেকমেন্ডেশন
- কাস্টমার যদি একটি প্রোডাক্ট নিতে চায়, সেই ক্যাটাগরির অন্য ১-২টি প্রোডাক্ট suggest করো।
- "এটার সাথে ___ও অনেকে নেন 😊" এই স্টাইলে বলো।
- জোর করে বিক্রি করার চেষ্টা করো না, শুধু হালকাভাবে suggest করো।

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
      const r = history[i].role === 'model' ? 'assistant' : history[i].role;
      apiMessages.push({ role: r, content: history[i].content });
    }
    apiMessages.push({ role: 'user', content: userContents });

    const completion = await openai.chat.completions.create({
      model: 'gemini-3.5-flash',
      messages: apiMessages,
    });

    const aiText = completion.choices[0].message.content;
    await ChatService.logMessage(conversation.id, 'assistant', aiText);
    await sendFacebookMessage(psid, pageId, aiText);

  } catch (err) {
    console.error('Error processing messages:', err);
    try {
      await sendFacebookMessage(psid, pageId,
        'দুঃখিত, এই মুহূর্তে আমি রেসপন্ড করতে পারছি না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন 🙏'
      );
    } catch (_) {}
  }
}

const crypto = require('crypto');
const { eq, desc, sql } = require('drizzle-orm');
const { conversations, customers, messages } = require('./src/db/schema');

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
    const { storeName, botName, baseCity, insideCityCharge, outsideCityCharge, aiEnabled, systemPersona, deliveryPolicy, paymentPolicy } = req.body;
    const existing = await db.select().from(businessConfig).limit(1);

    if (existing.length > 0) {
      await db.update(businessConfig)
        .set({ storeName, botName, baseCity, insideCityCharge, outsideCityCharge, aiEnabled, systemPersona, deliveryPolicy, paymentPolicy })
        .where(eq(businessConfig.id, existing[0].id));
    } else {
      await db.insert(businessConfig).values({
        id: crypto.randomUUID(),
        storeName,
        botName,
        baseCity,
        insideCityCharge,
        outsideCityCharge,
        aiEnabled,
        systemPersona,
        deliveryPolicy,
        paymentPolicy
      });
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

app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, price, sizes, features } = req.body;
    await db.update(products)
      .set({ name, price, sizes, features })
      .where(eq(products.id, req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id/toggle', async (req, res) => {
  try {
    const { isActive } = req.body;
    await db.update(products)
      .set({ isActive })
      .where(eq(products.id, req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const list = await db
      .select({
        id: conversations.id,
        status: conversations.status,
        startedAt: conversations.startedAt,
        lastMessageAt: conversations.lastMessageAt,
        firstName: customers.firstName,
        lastName: customers.lastName,
        psid: customers.psid,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(50);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, req.params.id))
      .orderBy(messages.createdAt);
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [{ count: totalConversations }] = await db.select({ count: sql`count(*)` }).from(conversations);
    const [{ count: totalCustomers }] = await db.select({ count: sql`count(*)` }).from(customers);
    const [{ count: totalMessages }] = await db.select({ count: sql`count(*)` }).from(messages);
    const [{ count: activeProducts }] = await db.select({ count: sql`count(*)` }).from(products).where(eq(products.isActive, true));

    res.json({ totalConversations, totalCustomers, totalMessages, activeProducts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const list = await db.select().from(customers).orderBy(desc(customers.lastActiveAt)).limit(100);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server on ${port}`));
