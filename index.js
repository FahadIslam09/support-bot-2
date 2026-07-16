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
Persona: ${storeConfig.systemPersona}
Store: ${storeConfig.storeName}
Delivery Policy: ${storeConfig.deliveryPolicy}
Payment Policy: ${storeConfig.paymentPolicy}

Inventory:
${inventoryTable}
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

app.listen(port, () => console.log(`Server on ${port}`));
