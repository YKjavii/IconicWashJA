// Vercel serverless function — emails the business (and the customer) when a booking is made, moved or cancelled.
// Env vars (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
//   optional: NOTIFY_TO (default iconicwashja@gmail.com), MAIL_FROM (set once your domain is verified in Resend,
//   e.g. "Iconic Car Wash <bookings@iconicwashja.com>" — this also turns on customer confirmation emails)
//   optional WhatsApp alert via CallMeBot: CALLMEBOT_PHONE (e.g. 18769954235), CALLMEBOT_APIKEY
const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY, RESEND = process.env.RESEND_API_KEY;
const TO = process.env.NOTIFY_TO || 'iconicwashja@gmail.com';
const FROM = process.env.MAIL_FROM || 'Iconic Car Wash <onboarding@resend.dev>';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const fmtDate = k => { const [y, m, d] = String(k).slice(0, 10).split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return DAYS[dt.getUTCDay()] + ', ' + MONTHS[m - 1] + ' ' + d + ', ' + y; };
const fmtTime = t => { let [h, m] = String(t).split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; };
const money = n => 'J$' + Number(n || 0).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function card(title, intro, rows) {
  return '<div style="background:#f7f5f0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#0f0e0c">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:2px solid #0f0e0c">' +
    '<div style="background:#0f0e0c;color:#c9a13b;padding:18px 24px;font-weight:800;letter-spacing:2px;font-size:14px">ICONIC CAR WASH</div>' +
    '<div style="padding:24px"><h1 style="margin:0 0 8px;font-size:24px">' + esc(title) + '</h1><p style="margin:0 0 20px;color:#5d574c;font-size:15px">' + esc(intro) + '</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:15px">' +
    rows.filter(r => r[1]).map(r => '<tr><td style="padding:10px 0;border-top:1px solid #e5e0d5;color:#7a7366;width:38%;vertical-align:top;font-size:12px;text-transform:uppercase;letter-spacing:1px">' + esc(r[0]) + '</td><td style="padding:10px 0;border-top:1px solid #e5e0d5;font-weight:600">' + esc(r[1]) + '</td></tr>').join('') +
    '</table></div></div></div>';
}
async function whatsapp(text) {
  const p = process.env.CALLMEBOT_PHONE, k = process.env.CALLMEBOT_APIKEY;
  if (!p || !k) return;
  try {
    const u = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(p.replace(/\D/g, '')) + '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(k);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    await fetch(u, { signal: ctl.signal }); clearTimeout(t);
  } catch (e) { console.error('CallMeBot', e); }
}
async function send(msg) {
  const post = m => fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
  let r = await post(msg);
  // custom sender not verified yet → retry from Resend's shared test sender
  if (!r.ok && r.status === 403 && msg.from !== 'Iconic Car Wash <onboarding@resend.dev>') r = await post(Object.assign({}, msg, { from: 'Iconic Car Wash <onboarding@resend.dev>' }));
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()));
}

module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.test === '1') {
    const env = { SUPABASE_URL: !!SB, SUPABASE_SERVICE_ROLE_KEY: !!KEY, RESEND_API_KEY: !!RESEND, MAIL_FROM: process.env.MAIL_FROM || '(not set)', NOTIFY_TO: TO };
    if (!RESEND) return res.status(500).json({ ok: false, env, error: 'RESEND_API_KEY is missing in Vercel' });
    try { await send({ from: FROM, to: [TO], subject: 'Iconic test email ✓', html: card('Test email', 'If you can read this, booking emails are working.', [['Sent', new Date().toISOString()]]) }); return res.json({ ok: true, env, sentTo: TO }); }
    catch (e) { return res.status(500).json({ ok: false, env, error: String(e.message || e) }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB || !KEY || !RESEND) return res.status(500).json({ error: 'Missing environment variables' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '').trim().toUpperCase(), type = body.type || 'new';
    if (!/^ICW-[A-Z0-9]{4,8}$/.test(id) || ['new', 'rescheduled', 'cancelled'].indexOf(type) < 0) return res.status(400).json({ error: 'Bad request' });
    const h = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    const r = await fetch(SB + '/rest/v1/bookings?id=eq.' + encodeURIComponent(id) + '&select=*', { headers: h });
    const b = (await r.json())[0];
    if (!b) return res.status(404).json({ error: 'Not found' });
    const ref = type === 'new' ? b.created_at : b.updated_at;
    if (Date.now() - new Date(ref).getTime() > 15 * 60 * 1000) return res.status(409).json({ error: 'Too old' });
    if (type === 'cancelled' && b.status !== 'cancelled') return res.status(409).json({ error: 'Not cancelled' });
    const sent = b.notified || {}, tag = type + '@' + ref;
    if (sent[tag]) return res.json({ ok: true, duplicate: true });

    const addons = (b.addons || []).map(a => a.name).join(', ');
    const rows = [['Booking ID', b.id], ['Service', b.service], ['Add-ons', addons || 'None'], ['Date', fmtDate(b.date)], ['Time', fmtTime(b.time)],
      ['Address', [b.service_address, b.area].filter(Boolean).join(', ')], ['Vehicle', [b.make, b.model, b.vehicle_type ? '(' + b.vehicle_type + ')' : '', b.plate ? '· ' + b.plate : ''].filter(Boolean).join(' ')],
      ['Est. total', money(b.price)]];
    const who = [['Name', b.name], ['Phone', b.phone], ['WhatsApp', b.whatsapp !== b.phone ? b.whatsapp : ''], ['Email', b.email], ['Contact by', b.contact], ['Notes', b.notes]];
    const word = { new: 'New booking', rescheduled: 'Booking rescheduled', cancelled: 'Booking cancelled' }[type];
    await send({ from: FROM, to: [TO], reply_to: b.email || undefined,
      subject: word + ' · ' + b.id + ' · ' + b.service + ' · ' + fmtDate(b.date) + ' ' + fmtTime(b.time),
      html: card(word, type === 'cancelled' ? 'The customer cancelled this appointment.' : 'Open the admin portal to manage it: https://iconicwashja.com/admin', who.concat(rows)) });
    const icon = { new: '🚗 *NEW BOOKING*', rescheduled: '🔁 *BOOKING MOVED*', cancelled: '❌ *BOOKING CANCELLED*' }[type];
    await whatsapp([icon + ' · ' + b.id, '',
      '*' + b.service + '*' + (addons ? ' + ' + addons : ''),
      '📅 ' + fmtDate(b.date) + ' · ' + fmtTime(b.time),
      '📍 ' + [b.service_address, b.area].filter(Boolean).join(', '),
      '👤 ' + (b.name || '') + ' · ' + (b.phone || ''),
      '🚘 ' + [b.make, b.model, b.plate].filter(Boolean).join(' '),
      '💵 ' + money(b.price),
      b.notes ? '📝 ' + b.notes : '', '', 'iconicwashja.com/admin'].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
    if (b.email && process.env.MAIL_FROM) {
      const cw = { new: 'You\'re booked', rescheduled: 'Your booking was moved', cancelled: 'Your booking was cancelled' }[type];
      await send({ from: FROM, to: [b.email], reply_to: TO, subject: cw + ' — ' + b.service + ', ' + fmtDate(b.date),
        html: card(cw + (b.name ? ', ' + b.name.split(' ')[0] : ''), type === 'cancelled' ? 'Hope to see you again soon. Book anytime at iconicwashja.com.' : 'We\'ll come to you at the address below. Reply to this email or WhatsApp +1 876-995-4235 with any questions. Pay on-site after the job.', rows) });
    }
    sent[tag] = new Date().toISOString();
    await fetch(SB + '/rest/v1/bookings?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: h, body: JSON.stringify({ notified: sent }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
};
