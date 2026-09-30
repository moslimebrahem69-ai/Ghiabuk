// ===== مفاتيح Supabase =====
const SUPABASE_URL = "https://lquvlukxwcidxlersefw.supabase.co";
const SUPABASE_KEY = "sb_publishable_kebX7bXD_jtzItzeTGjzfA_6byBy60e";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const GRADES = { 1: "الأول الثانوي", 2: "الثاني الثانوي", 3: "الثالث الثانوي" };

// الشعب الخاصة لكل صف
const TRACKS_BY_GRADE = {
  1: ["عام"],
  2: ["علمي", "أدبي", "بكالوريا"],
  3: ["علمي علوم", "علمي رياضة", "أدبي"]
};

const GOVERNORATES = [
  "القاهرة", "الجيزة", "الإسكندرية", "القليوبية", "الدقهلية", "الشرقية", "الغربية",
  "المنوفية", "البحيرة", "كفر الشيخ", "دمياط", "بورسعيد", "الإسماعيلية", "السويس",
  "الفيوم", "بني سويف", "المنيا", "أسيوط", "سوهاج", "قنا", "الأقصر", "أسوان",
  "البحر الأحمر", "الوادي الجديد", "مطروح", "شمال سيناء", "جنوب سيناء"
];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function errText(err) {
  const m = err?.message || String(err);
  const code = err?.code || "";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "مشكلة في الاتصال بالإنترنت، اتأكد من النت وجرب تاني";
  if (/Invalid login credentials/i.test(m)) return "الإيميل أو كلمة السر غلط";
  if (code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42883" ||
      /schema cache|does not exist/i.test(m))
    return "المنصة لسه مش متجهزة بالكامل. لو انت المدرس: شغّل ملفات SQL من 1 لـ 7 بالترتيب في Supabase.";
  if (code === "42501" || /permission denied/i.test(m)) return "مش مسموح لك تعمل كده";
  if (code === "23505" || /duplicate key/i.test(m)) return "البيانات دي متسجلة قبل كده";
  return m;
}

function cairoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

function fmtDate(d) {
  return new Date(d + "T00:00:00").toLocaleDateString("ar-EG-u-nu-latn", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "ص" : "م"}`;
}

function fmtShort(d) {
  const [, m, day] = d.split("-").map(Number);
  return `${day}/${m}`;
}

function fmtDays(days) {
  return (days || []).slice().sort((a, b) => a - b).map(d => DAYS[d]).join(" + ");
}

function groupLabel(g) {
  return g ? `${g.name} · ${fmtTime(g.start_time)}` : "بدون مجموعة";
}

function cairoDate(ts) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(ts));
}