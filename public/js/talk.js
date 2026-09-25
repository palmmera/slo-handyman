// Header "Talk" control. Opens a voice panel that uses the same quote steps
// as /request and only answers from SLO Handyman's own facts.

const MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/></svg>`;

const INSTRUCTIONS = `You are the voice of SLO Handyman, a booking site for independent handymen in San Luis Obispo County, California. Sound calm, brief, and professional. One or two short sentences at a time.

You are not the handyman. The site only connects customers with independent handymen. It does not do the work.

What you know:
- Service area is San Luis Obispo County only, including San Luis Obispo, Los Osos, Morro Bay, Cayucos, Cambria, Avila Beach, Pismo Beach, Grover Beach, Arroyo Grande, Oceano, Nipomo, Atascadero, Paso Robles, Templeton, Santa Margarita, and San Miguel.
- Categories: Painting, Plumbing, Electrical, Installation, Repairs, Moving, Pressure Washing, Landscaping, and Other.
- Customers can browse handymen or get a quote. A quote picks the next available handyman who fits the job and town, so work is shared instead of always going to the same person.
- The customer pays the job price plus a $5 booking fee by card on Stripe. The money is held. The handyman is not paid when they accept.
- After the handyman marks the work done, the customer releases payment. If they do nothing, it releases automatically after 72 hours. Reporting a problem on the booking page pauses that.
- If the assigned handyman declines or does not answer, the same paid job is offered to the next handyman. The customer is refunded only if nobody accepts.
- The customer manages the booking from a private link emailed after a handyman accepts, and shown on the confirmation page. They do not need a password for that link.
- Joining as a handyman is free at the Become a handyman page. Payouts are through Stripe. Handymen set their own rates. License and insurance are optional and self-reported.
- Never mention commission, the platform's cut, or how much the handyman is paid. Customers only need the booking fee and that payment is held until the work is done. If asked what the handyman receives, say payout details are in the handyman's own dashboard.
- Contact for the business: 805-323-8127 and slohandyman@smart-folder.com. The contact page is /contact.html. Terms are at /terms.html. FAQ is at /faq.html.
- Do not invent prices, availability, guarantees, license status, or arrival times. If you do not know, say the handyman will confirm that.
- If the person is off topic, answer in one sentence only when it is about this site, then return to the quote.

Quote order, one question at a time. Call the matching tool as soon as you have the answer:
1. What they need done. Call start_quote with their description.
2. First name, phone, and email. Call save_contact.
3. Confirm the category if you are unsure, then save_category. Categories must be exactly one of the list above.
4. Town or ZIP in San Luis Obispo County. Call save_place.
5. Timing: today, week, flexible, or a specific date as YYYY-MM-DD. Call save_timing.
6. Call match_handyman. Tell them the handyman's name and town. If they want someone else and others were returned, call choose_handyman with that id. Otherwise call choose_handyman with the first id.
7. When choose_handyman returns a url, tell them you are opening the handyman's page so they can enter the price and card. Do not ask for a card number.`;

const TOOLS = [
  { type: "function", name: "start_quote", description: "Save the job description and start the quote.", parameters: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
  { type: "function", name: "save_contact", description: "Save the customer's name, phone, and email.", parameters: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" } }, required: ["name", "phone", "email"] } },
  { type: "function", name: "save_category", description: "Save the job category.", parameters: { type: "object", properties: { category: { type: "string" } }, required: ["category"] } },
  { type: "function", name: "save_place", description: "Save a San Luis Obispo County town or ZIP.", parameters: { type: "object", properties: { place: { type: "string" } }, required: ["place"] } },
  { type: "function", name: "save_timing", description: "Save how soon the job is needed.", parameters: { type: "object", properties: { urgency: { type: "string", enum: ["today", "week", "flexible", "date"] }, date: { type: "string" } }, required: ["urgency"] } },
  { type: "function", name: "match_handyman", description: "Pick the next handyman in rotation.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "choose_handyman", description: "Choose a matched handyman and get the hire-page link.", parameters: { type: "object", properties: { handymanId: { type: "string" } }, required: ["handymanId"] } },
];

let token = "";
let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let playAt = 0;
let sources = [];
let pendingUrl = "";
let panel;
let statusEl;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

async function toolCall(name, args) {
  const post = (url, body) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token }),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That step didn't save.");
    return data;
  });
  if (name === "start_quote") {
    const data = await post("/api/assist/start", { description: args.description });
    token = data.token;
    return { ok: true, suggestedCategory: data.category, confident: data.confident };
  }
  if (name === "save_contact") return post("/api/assist/contact", args);
  if (name === "save_category") return post("/api/assist/category", args);
  if (name === "save_place") return post("/api/assist/place", args);
  if (name === "save_timing") return post("/api/assist/timing", args);
  if (name === "match_handyman") {
    const data = await post("/api/assist/match", {});
    if (!data.pick) return { ok: false, message: "No handyman is available. Offer the browse page at /#browse." };
    return {
      ok: true,
      pick: data.pick,
      others: data.others || [],
      widened: !!data.widened,
    };
  }
  if (name === "choose_handyman") {
    const data = await post("/api/assist/choose", { handymanId: args.handymanId });
    pendingUrl = data.url;
    return { ok: true, message: "Hire page is ready. Tell them you are opening it for the price and card." };
  }
  return { ok: false, message: "Unknown step." };
}

function stopPlayback() {
  for (const source of sources) {
    try { source.stop(); } catch { /* already ended */ }
  }
  sources = [];
  playAt = audioCtx ? audioCtx.currentTime : 0;
}

function playPcm16(base64) {
  if (!audioCtx) return;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
  const buffer = audioCtx.createBuffer(1, samples.length, 24000);
  buffer.copyToChannel(samples, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  const start = Math.max(audioCtx.currentTime + 0.05, playAt);
  source.start(start);
  playAt = start + buffer.duration;
  sources.push(source);
  source.onended = () => { sources = sources.filter((s) => s !== source); };
}

function floatToBase64(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function startVoice() {
  const secretRes = await fetch("/api/voice/session", { method: "POST" });
  const secret = await secretRes.json().catch(() => ({}));
  if (!secretRes.ok) throw new Error(secret.error || "Voice is unavailable.");

  let feeNote = "";
  try {
    const config = await fetch("/api/config").then((r) => r.json());
    if (config.bookingFee) feeNote = ` The booking fee is $${config.bookingFee}. Do not mention commission.`;
  } catch { /* the written instructions already cover the usual amounts */ }

  audioCtx = new AudioContext({ sampleRate: 24000 });
  await audioCtx.resume();
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const sourceNode = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  sourceNode.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);

  ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${secret.token}`]);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "eve",
        instructions: INSTRUCTIONS + feeNote,
        turn_detection: { type: "server_vad" },
        tools: TOOLS,
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 } },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
      },
    }));
    ws.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Greet them in one sentence and ask what they need done." },
    }));
    setStatus("Listening. Tell me what you need done.");
    panel.querySelector(".talk-orb").classList.add("live");
  });

  processor.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const channel = event.inputBuffer.getChannelData(0);
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: floatToBase64(channel) }));
  };

  ws.addEventListener("message", async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") {
      playPcm16(msg.delta);
      setStatus("Speaking…");
    } else if (msg.type === "input_audio_buffer.speech_started") {
      stopPlayback();
      setStatus("Listening…");
    } else if (msg.type === "response.function_call_arguments.done") {
      let args = {};
      try { args = JSON.parse(msg.arguments || "{}"); } catch { args = {}; }
      let result;
      try { result = await toolCall(msg.name, args); }
      catch (err) { result = { ok: false, message: err.message }; }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(result) },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
    } else if (msg.type === "response.done" && pendingUrl) {
      const url = pendingUrl;
      pendingUrl = "";
      setStatus("Opening the handyman's page…");
      setTimeout(() => { window.location = url; }, 900);
    } else if (msg.type === "error") {
      setStatus(msg.error?.message || "Voice hit a problem. You can type a quote instead.");
    }
  });

  ws.addEventListener("close", () => setStatus("The conversation ended."));
  ws.addEventListener("error", () => setStatus("Couldn't connect. You can type a quote instead."));
}

function stopVoice() {
  pendingUrl = "";
  token = "";
  if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null; }
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  micStream = null;
  stopPlayback();
  if (ws) { ws.close(); ws = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  const orb = panel && panel.querySelector(".talk-orb");
  if (orb) orb.classList.remove("live");
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "talk-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <h2>Talk through your quote</h2>
    <p class="talk-status" id="talkStatus">Ask a question, or describe the job.</p>
    <div class="talk-orb">${MIC}</div>
    <div class="talk-actions">
      <button type="button" class="btn" id="talkStart">Start talking</button>
      <button type="button" class="btn secondary" id="talkEnd">End</button>
    </div>
    <p class="hint" style="margin:12px 0 0">San Luis Obispo County. Your card is entered on the next page, not by voice. Prefer to type? <a href="/request">Get a quote</a>.</p>
  `;
  document.body.append(panel);
  statusEl = panel.querySelector("#talkStatus");
  panel.querySelector("#talkStart").addEventListener("click", async () => {
    panel.querySelector("#talkStart").disabled = true;
    setStatus("Connecting…");
    try { await startVoice(); }
    catch (err) {
      setStatus(err.message || "Microphone or voice is unavailable.");
      panel.querySelector("#talkStart").disabled = false;
      stopVoice();
    }
  });
  panel.querySelector("#talkEnd").addEventListener("click", () => {
    stopVoice();
    panel.hidden = true;
    panel.querySelector("#talkStart").disabled = false;
    setStatus("Ask a question, or describe the job.");
  });
  return panel;
}

function mount() {
  const nav = document.querySelector(".nav-links") || document.querySelector(".nav");
  if (!nav || document.getElementById("talkBtn")) return;
  const button = document.createElement("button");
  button.id = "talkBtn";
  button.type = "button";
  button.className = "talk-btn";
  button.setAttribute("aria-label", "Talk through your quote");
  button.innerHTML = `${MIC}<span>Talk</span>`;
  button.addEventListener("click", async () => {
    const box = ensurePanel();
    box.hidden = !box.hidden;
    if (!box.hidden) {
      try {
        const config = await fetch("/api/config").then((r) => r.json());
        if (!config.voiceConfigured) {
          setStatus("Voice isn't turned on yet. You can still type a quote.");
          box.querySelector("#talkStart").disabled = true;
        }
      } catch { /* the start button will report the error */ }
    } else {
      stopVoice();
      box.querySelector("#talkStart").disabled = false;
    }
  });
  nav.prepend(button);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
