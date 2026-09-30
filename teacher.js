const $ = id => document.getElementById(id);
const STUDENT_COLS = "code, full_name, phone, gender, governorate, grade, track, created_at";
const ACTIVE_KEY = "ghiyabak_active_session";
const ORDINALS = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة", "السادسة", "السابعة", "الثامنة", "التاسعة", "العاشرة"];

const state = {
  view: "home",
  grade: 1,
  students: [], byCode: new Map(),
  groups: [], groupById: new Map(),
  settings: {},       // الصف -> { price, lessons_count }
  gradeData: {},      // الصف -> { sessions, attendance, payments }
  active: null,       // الحصة الجارية
  live: [],           // حضور الحصة الجارية
  editingGroup: null,
  period: {},         // الصف -> رقم الفترة المختارة في الحسابات
};
let scanner = null;
let lastScan = { code: null, at: 0 };
let inDashboard = false;
let sessionSubscription = null;

// ================= أدوات عامة =================
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString("ar-EG-u-nu-latn", { day: "numeric", month: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString("ar-EG-u-nu-latn", { hour: "numeric", minute: "2-digit" });
}
function money(n) { return `${Math.round(n).toLocaleString("ar-EG-u-nu-latn")} ج`; }

async function fetchAll(table, cols, apply) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ================= الدخول =================
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  $("loginMsg").textContent = "";
  const { error } = await sb.auth.signInWithPassword({
    email: $("tEmail").value.trim(),
    password: $("tPass").value
  });
  btn.disabled = false;
  if (error) $("loginMsg").textContent = errText(error);
});

$("logoutBtn").addEventListener("click", async () => {
  await stopCamera();
  if (sessionSubscription) sb.removeChannel(sessionSubscription);
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => {
    if (session) $("teacherEmail").textContent = session.user?.email || "";
    if (session && !inDashboard) enterDashboard();
    else if (!session) showLogin();
  }, 0);
});

function showLogin() {
  inDashboard = false;
  $("loginView").hidden = false;
  $("dashView").hidden = true;
  $("logoutBtn").hidden = true;
}

async function enterDashboard() {
  inDashboard = true;
  const { data: ok, error } = await sb.rpc("is_teacher");
  if (error || !ok) {
    await sb.auth.signOut();
    $("loginMsg").textContent = "الحساب ده مش متسجل كمدرس. ضيف الإيميل في جدول teachers.";
    return;
  }
  $("loginView").hidden = true;
  $("dashView").hidden = false;
  $("logoutBtn").hidden = false;
  try {
    await Promise.all([loadStudents(), loadGroups(), loadSettings()]);
    await restoreActive();
    subscribeToSessions();
  } catch (err) { toast(errText(err)); }
  showView(state.view);
}

// ================= المزامنة المباشرة (Realtime) =================
function subscribeToSessions() {
  if (sessionSubscription) return;
  sessionSubscription = sb
    .channel('public:sessions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, async payload => {
      await restoreActive();
      if (state.view === "scan") renderScan();
    })
    .subscribe();
}

// ================= تحميل البيانات =================
async function loadStudents() {
  state.students = await fetchAll("students", STUDENT_COLS, q => q.order("code"));
  state.byCode = new Map(state.students.map(s => [s.code, s]));
}

async function loadGroups() {
  state.groups = await fetchAll("groups", "*", q => q.order("grade").order("start_time").order("id"));
  state.groupById = new Map(state.groups.map(g => [g.id, g]));
}

async function loadSettings() {
  const { data, error } = await sb.from("grade_settings").select("*");
  if (error) throw error;
  state.settings = Object.fromEntries(data.map(s => [s.grade, s]));
}

async function loadGradeData(grade, force = false) {
  if (!force && state.gradeData[grade]) return state.gradeData[grade];
  const [sessions, attendance, payments] = await Promise.all([
    fetchAll("sessions", "id, grade, group_id, lesson_no, day, started_at, closed_at", q => q.eq("grade", grade).order("id")),
    fetchAll("attendance", "id, session_id, student_code, lesson_no, scanned_at", q => q.eq("grade", grade).order("id")),
    fetchAll("payments", "*", q => q.eq("grade", grade).order("id")),
  ]);
  return (state.gradeData[grade] = { sessions, attendance, payments });
}

function invalidate(grade) { delete state.gradeData[grade]; }

const gradeGroups = (grade, onlyActive = false) =>
  state.groups.filter(g => g.grade === grade && (!onlyActive || g.active));

// ================= التنقل =================
document.querySelectorAll("#nav button").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));

function showView(view) {
  if (state.view === "scan" && view !== "scan") stopCamera();
  state.view = view;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelector("#nav button.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== "view-" + view));
  renderGradeSegs();
  renderView();
}

function renderGradeSegs() {
  document.querySelectorAll(".grade-seg").forEach(seg => {
    seg.innerHTML = [1, 2, 3].map(g =>
      `<button type="button" data-grade="${g}" class="${g === state.grade ? "active" : ""}">${GRADES[g]}</button>`).join("");
  });
}

document.addEventListener("click", e => {
  const b = e.target.closest(".grade-seg button");
  if (!b) return;
  state.grade = Number(b.dataset.grade);
  renderGradeSegs();
  renderView();
});

async function renderView() {
  const v = state.view, grade = state.grade;
  if (v === "home") return renderHome();
  if (v === "groups") return renderGroups();
  if (v === "scan") return renderScan();
  if (v === "students") return renderStudents();

  const target = v === "register" ? $("regContent") : $("payBody");
  if (!state.gradeData[grade]) target.innerHTML = v === "register"
    ? `<p class="empty">جاري التحميل...</p>` : `<tr><td colspan="8" class="empty">جاري التحميل...</td></tr>`;
  try { await loadGradeData(grade); } catch (err) { return toast(errText(err)); }
  if (state.view !== v || state.grade !== grade) return;
  v === "register" ? renderRegister() : renderPayments();
}

// ================= الرئيسية =================
function renderHome() {
  const S = state.students;

  const count = f => S.filter(f).length;
  $("stTotal").textContent = S.length;
  $("stGender").textContent = `ذكور ${count(s => s.gender === "ذكر")} · إناث ${count(s => s.gender === "أنثى")}`;
  for (const g of [1, 2, 3]) {
    const list = S.filter(s => s.grade === g);
    $("stG" + g).textContent = list.length;
    $("stG" + g + "s").textContent = (TRACKS_BY_GRADE[g] || []).map(t => `${t} ${list.filter(s => s.track === t).length}`).join(" · ");
  }
  const row = (label, list, groups, strong) => {
    const allTracks = ["أدبي", "علمي علوم", "علمي رياضة"];
    const cells = [
      ...allTracks.map(t => list.filter(s => s.track === t).length),
      list.filter(s => s.gender === "ذكر").length,
      list.filter(s => s.gender === "أنثى").length,
      groups,
      list.length
    ];
    const wrap = v => (strong ? `<b>${v}</b>` : v);
    return `<tr><td>${wrap(label)}</td>${cells.map(c => `<td>${wrap(c)}</td>`).join("")}</tr>`;
  };
  $("breakdownBody").innerHTML =
    [1, 2, 3].map(g => row(GRADES[g], S.filter(s => s.grade === g), gradeGroups(g, true).length)).join("") +
    row("الإجمالي", S, state.groups.filter(g => g.active).length, true);
}

// ================= المجموعات =================
$("gDays").innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" value="${i}"> ${d}</label>`).join("");

function renderGroups() {
  const list = gradeGroups(state.grade);

  $("groupsBody").innerHTML = list.length
    ? list.map(g => `<tr>
        <td><b>${esc(g.name)}</b></td>
        <td>${fmtTime(g.start_time)}</td>
        <td>${esc(fmtDays(g.days)) || "—"}</td>
        <td>${g.active ? `<span class="badge ok">شغالة</span>` : `<span class="badge off">موقوفة</span>`}</td>
        <td><div class="row-actions">
          <button class="btn ghost sm" data-act="edit" data-id="${g.id}" type="button">تعديل</button>
          <button class="btn ghost sm" data-act="toggle" data-id="${g.id}" type="button">${g.active ? "إيقاف" : "تشغيل"}</button>
          <button class="btn danger sm" data-act="del" data-id="${g.id}" type="button">حذف</button>
        </div></td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">مفيش مجموعات للصف ده لسه، ضيف أول مجموعة من تحت</td></tr>`;

  if (!state.editingGroup || state.editingGroup.grade !== state.grade) resetGroupForm();
}

function resetGroupForm() {
  state.editingGroup = null;
  const n = gradeGroups(state.grade).length;
  $("groupFormTitle").textContent = `إضافة مجموعة جديدة — ${GRADES[state.grade]}`;
  $("gName").value = `المجموعة ${ORDINALS[n] || n + 1}`;
  $("gTime").value = "";
  document.querySelectorAll("#gDays input").forEach(c => (c.checked = false));
  $("groupSave").textContent = "إضافة المجموعة";
  $("groupCancel").hidden = true;
  $("groupMsg").textContent = "";
}

$("groupCancel").addEventListener("click", resetGroupForm);

$("groupsBody").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const g = state.groupById.get(Number(b.dataset.id));
  if (!g) return;

  if (b.dataset.act === "edit") {
    state.editingGroup = g;
    $("groupFormTitle").textContent = `تعديل ${g.name} — ${GRADES[g.grade]}`;
    $("gName").value = g.name;
    $("gTime").value = g.start_time.slice(0, 5);
    document.querySelectorAll("#gDays input").forEach(c => (c.checked = (g.days || []).includes(Number(c.value))));
    $("groupSave").textContent = "حفظ التعديل";
    $("groupCancel").hidden = false;
    $("groupForm").scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (b.dataset.act === "toggle") {
    const { error } = await sb.from("groups").update({ active: !g.active }).eq("id", g.id);
    if (error) return toast(errText(error));
    toast(g.active ? "المجموعة اتوقفت" : "المجموعة اشتغلت");
  }

  if (b.dataset.act === "del") {
    if (!confirm(`متأكد إنك عاوز تمسح ${g.name}؟\nالطلاب اللي فيها هيبقوا من غير مجموعة.`)) return;
    const { error } = await sb.from("groups").delete().eq("id", g.id);
    if (error) return toast(error.code === "23503" ? "المجموعة دي فيها حصص متسجلة، اوقفها بدل ما تمسحها" : errText(error));
    toast("المجموعة اتمسحت");
    await loadStudents();
  }

  await loadGroups();
  renderGroups();
});

$("groupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("gName").value.trim();
  const time = $("gTime").value;
  const days = [...document.querySelectorAll("#gDays input:checked")].map(c => Number(c.value));
  if (!name) return ($("groupMsg").textContent = "اكتب اسم المجموعة");
  if (!time) return ($("groupMsg").textContent = "اختار وقت المجموعة");
  $("groupMsg").textContent = "";

  const row = { name, start_time: time, days };
  const { error } = state.editingGroup
    ? await sb.from("groups").update(row).eq("id", state.editingGroup.id)
    : await sb.from("groups").insert({ ...row, grade: state.grade });
  if (error) return ($("groupMsg").textContent = errText(error));

  toast(state.editingGroup ? "التعديل اتحفظ" : "المجموعة اتضافت");
  state.editingGroup = null;
  await loadGroups();
  renderGroups();
});

// ================= تسجيل الحضور =================
async function restoreActive() {
  const { data } = await sb.from("sessions").select("*").is("closed_at", null).maybeSingle();
  if (data) {
    state.active = data;
    state.grade = data.grade;
    lsSet(ACTIVE_KEY, String(data.id));
    await loadLive();
  } else {
    state.active = null;
    state.live = [];
    lsSet(ACTIVE_KEY, null);
  }
}

function renderScan() {
  const live = !!state.active;
  $("startCard").hidden = live;
  $("liveView").hidden = !live;
  if (live) { renderLive(); loadQrLib().catch(() => {}); }
  else fillStartForm();
  renderRecent();
}

function fillStartForm() {
  const list = gradeGroups(state.grade, true);
  if (!list.length) {
    $("sGroup").innerHTML = `<option value="">مفيش مجموعات شغالة — ضيفها من صفحة المجموعات</option>`;
    $("sLesson").value = "";
    $("sHint").textContent = "";
    $("startBtn").disabled = true;
    return;
  }
  $("startBtn").disabled = false;
  const prev = Number($("sGroup").value);
  $("sGroup").innerHTML = list.map(g =>
    `<option value="${g.id}">${esc(groupLabel(g))}${g.days?.length ? " — " + esc(fmtDays(g.days)) : ""}</option>`).join("");

  let pick = list.find(g => g.id === prev);
  if (!pick) {
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes(), today = now.getDay();
    const toMins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    const todays = list.filter(g => (g.days || []).includes(today));
    pick = (todays.length ? todays : list)
      .slice().sort((a, b) => Math.abs(toMins(a.start_time) - mins) - Math.abs(toMins(b.start_time) - mins))[0];
  }
  $("sGroup").value = pick.id;
  updateLessonHint();
}

$("sGroup").addEventListener("change", updateLessonHint);

async function updateLessonHint() {
  const gid = Number($("sGroup").value), grade = state.grade;
  if (!gid) return;
  $("sHint").textContent = "";
  const [r1, r2] = await Promise.all([
    sb.from("sessions").select("lesson_no, day").eq("group_id", gid).order("lesson_no", { ascending: false }).limit(1),
    sb.from("sessions").select("lesson_no, day").eq("grade", grade).order("lesson_no", { ascending: false }).limit(1),
  ]);
  if (Number($("sGroup").value) !== gid) return;
  const groupLast = r1.data?.[0], gradeLast = r2.data?.[0];
  $("sLesson").value = (groupLast?.lesson_no || 0) + 1;
  $("sHint").textContent =
    (groupLast ? `آخر حصة للمجموعة دي: الحصة ${groupLast.lesson_no} يوم ${fmtShort(groupLast.day)}.` : "دي أول حصة للمجموعة دي.") +
    (gradeLast ? ` أعلى رقم حصة في الصف: ${gradeLast.lesson_no}.` : "") +
    " المجموعات اللي بتاخد نفس الدرس لازم يبقى ليها نفس رقم الحصة.";
}

$("startBtn").addEventListener("click", () => startSession(Number($("sGroup").value), Number($("sLesson").value)));

async function startSession(groupId, lessonNo) {
  if (!groupId) return toast("اختار المجموعة");
  if (!(lessonNo >= 1)) return toast("اكتب رقم الحصة");

  // 1. منع فتح حصة ثانية لو كان هناك حصة جارية بالفعل
  const { data: openSession } = await sb.from("sessions").select("id, grade, group_id, lesson_no").is("closed_at", null).maybeSingle();
  if (openSession) {
    const groupName = state.groupById.get(openSession.group_id)?.name || "";
    return alert(`⚠️ هناك حصة جارية بالفعل (${GRADES[openSession.grade]} - ${groupName} - الحصة ${openSession.lesson_no})!\nيجب إنهاء الحصة المفتوحة أولاً قبل فتح حصة جديدة.`);
  }

  // 2. التحقق من عدم تكرار رقم الحصة لنفس المجموعة
  const { data: duplicate } = await sb.from("sessions").select("id").eq("group_id", groupId).eq("lesson_no", lessonNo).maybeSingle();
  if (duplicate) {
    return alert(`❌ الحصة رقم ${lessonNo} تم إنشاؤها وتأكيدها من قبل لهذه المجموعة!\nرجاء اختر رقم حصة جديد.`);
  }

  const { data, error } = await sb.rpc("start_session", { p_group_id: groupId, p_lesson_no: lessonNo });
  if (error) return toast(errText(error));
  state.active = data;
  state.grade = data.grade;
  lsSet(ACTIVE_KEY, String(data.id));
  invalidate(data.grade);
  toast(data.resumed ? `رجعت للحصة ${data.lesson_no} (يوم ${fmtShort(data.day)})` : "بدأ تسجيل الحضور");
  $("scanResult").hidden = true;
  lastScan = { code: null, at: 0 };
  await loadLive();
  renderGradeSegs();
  renderScan();
}

async function loadLive() {
  if (!state.active) return;
  const { data, error } = await sb.from("attendance")
    .select("id, student_code, scanned_at").eq("session_id", state.active.id).order("scanned_at", { ascending: false });
  if (error) return toast(errText(error));
  state.live = data;
  if (state.view === "scan") renderLive();
}

function renderLive() {
  const se = state.active, g = state.groupById.get(se.group_id);
  $("liveTitle").textContent = `${GRADES[se.grade]} ← ${groupLabel(g)}`;
  $("liveSub").textContent = `الحصة ${se.lesson_no} · ${fmtDate(se.day)}`;
  const gradeSize = state.students.filter(s => s.grade === se.grade).length;
  $("liveCount").textContent = `(${state.live.length} من ${gradeSize} طالب في الصف)`;
  $("liveBody").innerHTML = state.live.length
    ? state.live.map(a => {
        const s = state.byCode.get(a.student_code) || { full_name: "?" };
        return `<tr>
          <td>${fmtClock(a.scanned_at)}</td>
          <td class="num"><b>${a.student_code}</b></td>
          <td>${esc(s.full_name)}</td>
          <td><button class="btn danger sm" data-del="${a.id}" type="button" title="إلغاء الحضور">✕</button></td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="empty">لسه محدش اتسجل، ابدأ امسح الـ QR</td></tr>`;
}

$("liveBody").addEventListener("click", async e => {
  const b = e.target.closest("button[data-del]");
  if (!b || !confirm("تلغي حضور الطالب ده في الحصة دي؟")) return;
  const { error } = await sb.from("attendance").delete().eq("id", Number(b.dataset.del));
  if (error) return toast(errText(error));
  invalidate(state.active.grade);
  lastScan = { code: null, at: 0 };
  loadLive();
});

$("endBtn").addEventListener("click", async () => {
  if (!state.active || !confirm("تنهي الحصة وتقفل تسجيل الحضور؟")) return;
  const { error } = await sb.from("sessions").update({ closed_at: new Date().toISOString() }).eq("id", state.active.id);
  if (error) return toast(errText(error));
  await stopCamera();
  invalidate(state.active.grade);
  toast(`الحصة خلصت · حضر ${state.live.length} طالب`);
  state.active = null;
  state.live = [];
  lsSet(ACTIVE_KEY, null);
  renderScan();
});

async function renderRecent() {
  const { data, error } = await sb.from("sessions")
    .select("id, grade, group_id, lesson_no, day, closed_at, attendance(count)")
    .order("started_at", { ascending: false }).limit(12);
  if (error) return;
  $("recentBody").innerHTML = data.length
    ? data.map(s => {
        const isActive = state.active?.id === s.id;
        return `<tr>
          <td>${esc(DAYS[new Date(s.day + "T00:00:00").getDay()])} ${fmtShort(s.day)}</td>
          <td>${GRADES[s.grade]}</td>
          <td>${esc(groupLabel(state.groupById.get(s.group_id)))}</td>
          <td>الحصة ${s.lesson_no}</td>
          <td>${s.attendance?.[0]?.count ?? 0}</td>
          <td>${s.closed_at ? `<span class="badge off">خلصت</span>` : `<span class="badge warn">جارية</span>`}</td>
          <td><div class="row-actions">
            <button class="btn ghost sm" type="button" data-sheet="${s.grade}:${s.lesson_no}">📄 PDF</button>
            ${isActive ? "" : `<button class="btn ghost sm" type="button" data-open="${s.group_id}:${s.lesson_no}">فتح</button>`}
          </div></td></tr>`;
      }).join("")
    : `<tr><td colspan="7" class="empty">لسه مفيش حصص</td></tr>`;
}

$("recentBody").addEventListener("click", async e => {
  const sheet = e.target.closest("button[data-sheet]");
  if (sheet) {
    const [grade, lesson] = sheet.dataset.sheet.split(":").map(Number);
    return printLessonSheet(grade, lesson);
  }
  const b = e.target.closest("button[data-open]");
  if (!b) return;
  if (state.active && !confirm("فيه حصة جارية دلوقتي. تفتح الحصة دي بدالها؟")) return;
  const [gid, lesson] = b.dataset.open.split(":").map(Number);
  startSession(gid, lesson);
});

// ----- مسح الـ QR -----
function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), gain = ctx.createGain();
    o.frequency.value = ok ? 880 : 240;
    gain.gain.value = 0.15;
    o.connect(gain).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.15 : 0.35));
  } catch {}
}

function showResult(type, html) {
  const el = $("scanResult");
  el.className = "scan-result " + type;
  el.innerHTML = html;
  el.hidden = false;
}

async function markAttendance(raw) {
  if (!state.active) return;
  const code = parseInt(String(raw).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, ""), 10);
  if (!code) return showResult("err", "الكود مش صحيح");

  const now = Date.now();
  if (lastScan.code === code && now - lastScan.at < 3000) return;
  lastScan = { code, at: now };

  const { data, error } = await sb.rpc("mark_attendance", { p_session_id: state.active.id, p_code: code });
  if (error) { beep(false); return showResult("err", esc(errText(error))); }

  const info = `<b>${esc(data.full_name)}</b><br>كود ${data.code} · ${GRADES[data.grade]} · ${esc(data.track)}`;
  if (data.already) {
    beep(false);
    showResult("warn", `⚠️ متسجل حضور قبل كده في الحصة دي${data.already_group ? ` (مع ${esc(data.already_group)})` : ""}<br>${info}`);
  } else {
    beep(true);
    showResult("ok", `✅ تم تسجيل الحضور<br>${info}`);
    invalidate(state.active.grade);
    loadLive();
  }
}

$("manualForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("manualCode").value;
  $("manualCode").value = "";
  lastScan = { code: null, at: 0 };
  markAttendance(v);
});

// ----- الكاميرا -----
let qrLibLoading = null;
function loadQrLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  return qrLibLoading ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.onload = ok;
    s.onerror = () => { qrLibLoading = null; s.remove(); fail(new Error("مش قادر أحمّل قارئ الـ QR، اتأكد من النت وجرب تاني")); };
    document.head.appendChild(s);
  });
}

let cameras = []; 
let camIndex = -1;

const QR_ONLY = () => ({ formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
const SCAN_CFG = {
  fps: 10,
  aspectRatio: 1,
  qrbox: (w, h) => { const s = Math.max(120, Math.floor(Math.min(w, h) * 0.7)); return { width: s, height: s }; },
};

function camHelp(html) {
  $("camHelp").innerHTML = html || "";
  $("camHelp").hidden = !html;
}

function cameraProblem(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  if (!window.isSecureContext)
    return `الكاميرا مش بتشتغل غير لو الموقع مفتوح بـ <b>https</b>، وانت فاتح <b class="ltr-inline">${esc(location.origin)}</b>.<br>
      ارفع المنصة (مثلاً على Netlify) وافتح الرابط اللي بيبدأ بـ https. لحد كده استخدم «صوّر الـ QR».`;
  if (!navigator.mediaDevices?.getUserMedia)
    return `المتصفح ده مش بيدعم الكاميرا. لو فاتح الرابط من واتساب أو فيسبوك، افتحه في <b>Chrome</b> أو <b>Safari</b>
      (من ⋮ ← فتح في المتصفح). لحد كده استخدم «صوّر الـ QR».`;
  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(msg))
    return `إذن الكاميرا مرفوض. دوس على علامة 🔒 جنب الرابط فوق ← <b>الأذونات</b> ← <b>الكاميرا</b> ← <b>سماح</b>، وبعدين جرّب تاني.
      <br>على الآيفون: الإعدادات ← Safari ← الكاميرا ← سماح.`;
  if (name === "NotFoundError" || /not ?found|no camera/i.test(msg))
    return `مش لاقي كاميرا على الجهاز ده. استخدم «صوّر الـ QR» أو اكتب الكود.`;
  if (name === "NotReadableError" || /could not start|in use|notreadable/i.test(msg))
    return `الكاميرا مفتوحة في تطبيق تاني. اقفل أي تطبيق بيستخدم الكاميرا وجرّب تاني.`;
  return `مش قادر أفتح الكاميرا (${esc(msg)}). جرّب «صوّر الـ QR» أو اكتب الكود.`;
}

function pickBackCamera(list) {
  const i = list.findIndex(c => /back|rear|environment|خلف/i.test(c.label));
  return i >= 0 ? i : list.length - 1;
}

async function startCamera() {
  camHelp("");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return camHelp(cameraProblem());
  $("camBtn").disabled = true;
  try { await loadQrLib(); } catch (err) { $("camBtn").disabled = false; return camHelp(esc(err.message)); }
  scanner = new Html5Qrcode("reader", QR_ONLY());
  const onScan = text => markAttendance(text);
  try {
    const source = cameras[camIndex] ? cameras[camIndex].id : { facingMode: "environment" };
    try {
      await scanner.start(source, SCAN_CFG, onScan, () => {});
    } catch (first) {
      if (first?.name === "NotAllowedError") throw first;
      cameras = await Html5Qrcode.getCameras();
      if (!cameras.length) throw first;
      camIndex = pickBackCamera(cameras);
      await scanner.start(cameras[camIndex].id, SCAN_CFG, onScan, () => {});
    }
    $("camBtn").textContent = "⏹ إيقاف الكاميرا";
    if (!cameras.length) cameras = await Html5Qrcode.getCameras().catch(() => []);
    $("switchCamBtn").hidden = cameras.length < 2;
  } catch (err) {
    try { scanner.clear(); } catch {}
    scanner = null;
    $("reader").innerHTML = "";
    camHelp(cameraProblem(err));
  } finally {
    $("camBtn").disabled = false;
  }
}

async function stopCamera() {
  if (!scanner) return;
  try { await scanner.stop(); scanner.clear(); } catch {}
  scanner = null;
  $("reader").innerHTML = "";
  $("camBtn").textContent = "📷 تشغيل الكاميرا";
  $("switchCamBtn").hidden = true;
}

$("camBtn").addEventListener("click", () => (scanner ? stopCamera() : startCamera()));

$("switchCamBtn").addEventListener("click", async () => {
  if (cameras.length < 2) return;
  camIndex = ((camIndex < 0 ? pickBackCamera(cameras) : camIndex) + 1) % cameras.length;
  await stopCamera();
  startCamera();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stopCamera();
});

$("qrFile").addEventListener("change", async e => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || !state.active) return;
  try { await loadQrLib(); } catch (err) { beep(false); return showResult("err", esc(err.message)); }
  const reader = new Html5Qrcode("qrFileReader", QR_ONLY());
  try {
    const text = await reader.scanFile(file, false);
    lastScan = { code: null, at: 0 };
    await markAttendance(text);
  } catch {
    beep(false);
    showResult("err", "مش لاقي QR في الصورة. قرّب الموبايل من الـ QR وخلي الصورة واضحة وجرّب تاني.");
  } finally {
    try { reader.clear(); } catch {}
  }
});

// ================= حساب سجل الحضور =================
function lessonsOf(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const l = map.get(s.lesson_no) || { no: s.lesson_no, first: s.day, last: s.day };
    if (s.day < l.first) l.first = s.day;
    if (s.day > l.last) l.last = s.day;
    map.set(s.lesson_no, l);
  }
  return [...map.values()].sort((a, b) => a.no - b.no);
}

function buildRegister(data) {
  const lessons = lessonsOf(data.sessions);
  const sessionById = new Map(data.sessions.map(s => [s.id, s]));
  const att = new Map(data.attendance.map(a => [a.student_code + ":" + a.lesson_no, a]));

  function rowFor(s, list = lessons) {
    const joined = cairoDate(s.created_at);
    let held = 0, present = 0;
    const cells = list.map(l => {
      const a = att.get(s.code + ":" + l.no);
      if (a) {
        held++; present++;
        const se = sessionById.get(a.session_id);
        return { mark: "yes", group: se && state.groupById.get(se.group_id), day: se?.day };
      }
      if (joined > l.last) return { mark: "na" };
      held++;
      return { mark: "no" };
    });
    return { cells, held, present, absent: held - present };
  }
  return { lessons, rowFor };
}

function gradeStudents(grade) {
  return state.students.filter(s => s.grade === grade)
    .sort((a, b) => a.full_name.localeCompare(b.full_name, "ar"));
}

const MARKS = {
  yes: `<span class="m-yes">حضر</span>`,
  no: `<span class="m-no">غائب</span>`,
  na: `<span class="m-na">—</span>`,
};

function registerHTML(grade) {
  const R = buildRegister(state.gradeData[grade]);
  const students = gradeStudents(grade);
  if (!students.length) return `<p class="empty">مفيش طلاب في الصف ده لسه</p>`;
  const lessonHeads = R.lessons.map(l => `<th class="l">ح${l.no}<small>${fmtShort(l.first)}</small></th>`).join("");
  const rows = students.map((s, i) => {
    const r = R.rowFor(s);
    const cells = r.cells.map(c => {
      if (c.mark !== "yes") return `<td class="l">${MARKS[c.mark]}</td>`;
      const tip = ` title="حضر مع ${esc(groupLabel(c.group))} يوم ${fmtShort(c.day)}"`;
      return `<td class="l"${tip}>${MARKS.yes}<small class="m-grp">${c.group ? fmtTime(c.group.start_time) : ""}</small></td>`;
    }).join("");
    return `<tr><td>${i + 1}</td><td class="name">${esc(s.full_name)}</td><td class="num">${s.code}</td>${cells}
      <td>${r.held}</td><td><b class="m-yes">${r.present}</b></td><td><b class="m-no">${r.absent}</b></td></tr>`;
  }).join("");
  return `<section class="reg-group"><h3>${GRADES[grade]}<small>${students.length} طالب · ${R.lessons.length} حصة</small></h3>
    <div class="table-wrap"><table class="reg">
      <thead><tr><th>#</th><th>اسم الطالب</th><th>الكود</th>${lessonHeads}<th>عدد الحصص</th><th>حضر</th><th>غاب</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></section>`;
}

function renderRegister() {
  const data = state.gradeData[state.grade];
  const n = lessonsOf(data.sessions).length;
  $("regContent").innerHTML =
    (n ? "" : `<p class="muted">لسه مفيش حصص متسجلة للصف ده. أول ما تبدأ تسجيل حضور هتظهر هنا.</p>`) +
    registerHTML(state.grade);
}

$("regPdf").addEventListener("click", async () => {
  const grade = state.grade;
  await loadGradeData(grade);
  const n = lessonsOf(state.gradeData[grade].sessions).length;
  const legend = `<div class="legend"><span><b class="m-yes">حضر</b> (وتحتها ميعاد المجموعة اللي حضر معاها)</span><span><b class="m-no">غائب</b></span><span>— لسه ماكانش مسجل</span></div>`;
  printDoc(`${GRADES[grade]} – سجل الحضور`,
    `عدد الحصص: ${n} · عدد الطلاب: ${state.students.filter(s => s.grade === grade).length} · تاريخ التقرير: ${fmtDateTime(new Date())}`,
    legend + registerHTML(grade), n > 18 ? "small" : "");
});

async function printLessonSheet(grade, lessonNo) {
  let data;
  try { data = await loadGradeData(grade, true); } catch (err) { return toast(errText(err)); }
  const sessions = data.sessions.filter(x => x.lesson_no === lessonNo);
  if (!sessions.length) return toast("مفيش بيانات للحصة دي");
  const sessionById = new Map(sessions.map(x => [x.id, x]));
  const att = new Map(data.attendance.filter(a => a.lesson_no === lessonNo).map(a => [a.student_code, a]));
  const lastDay = sessions.reduce((m, x) => (x.day > m ? x.day : m), sessions[0].day);
  const students = gradeStudents(grade).filter(st => att.has(st.code) || cairoDate(st.created_at) <= lastDay);

  const present = students.filter(st => att.has(st.code)).length;
  const absent = students.length - present;
  const rows = students.map((st, i) => {
    const a = att.get(st.code);
    const g = a && state.groupById.get(sessionById.get(a.session_id)?.group_id);
    return a
      ? `<tr><td>${i + 1}</td><td class="name">${esc(st.full_name)}</td><td>${st.code}</td>
          <td><b class="m-yes">حضر</b></td><td>${esc(groupLabel(g))}</td><td>${fmtClock(a.scanned_at)}</td></tr>`
      : `<tr class="absent"><td>${i + 1}</td><td class="name">${esc(st.full_name)}</td><td>${st.code}</td>
          <td><b class="m-no">غائب</b></td><td>—</td><td>—</td></tr>`;
  }).join("");

  const days = [...new Set(sessions.map(x => x.day))].sort().map(fmtDate).join(" و ");
  const groups = sessions.map(x => groupLabel(state.groupById.get(x.group_id))).join("، ");
  const body = `
    <div class="summary">
      <div><b>${students.length}</b>عدد الطلاب</div>
      <div class="yes"><b>${present}</b>حضر</div>
      <div class="no"><b>${absent}</b>غائب</div>
    </div>
    <table><thead><tr><th>#</th><th>اسم الطالب</th><th>الكود</th><th>الحالة</th><th>حضر مع</th><th>وقت الحضور</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">مفيش طلاب في الصف ده</td></tr>'}</tbody></table>`;
  printDoc(`${GRADES[grade]} – الحصة ${lessonNo} – كشف الحضور`,
    `${days} · المجموعات: ${groups} · تاريخ التقرير: ${fmtDateTime(new Date())}`, body, "", false);
}

$("liveSheetBtn").addEventListener("click", () => {
  if (state.active) printLessonSheet(state.active.grade, state.active.lesson_no);
});

// ================= الحسابات =================
function renderPayments() {
  const grade = state.grade;
  const data = state.gradeData[grade];
  const set = state.settings[grade] || { price: 0, lessons_count: 12 };
  const price = Number(set.price) || 0, n = Number(set.lessons_count) || 12;
  if (document.activeElement !== $("setPrice")) $("setPrice").value = price;
  if (document.activeElement !== $("setCount")) $("setCount").value = n;
  $("setHint").textContent = price
    ? `سعر الحصة = ${price} ÷ ${n} = ${(price / n).toFixed(2)} جنيه تقريبًا. المستحق = عدد الحصص اللي حضرها × سعر الحصة.`
    : "حدد سعر الصف وعدد الحصص في الفترة عشان المبالغ تتحسب.";

  const R = buildRegister(data);
  const maxLesson = R.lessons.length ? R.lessons[R.lessons.length - 1].no : 0;
  const periods = Math.max(1, Math.ceil(maxLesson / n));
  let p = state.period[grade];
  if (!p || p > periods) p = periods;
  state.period[grade] = p;
  $("payPeriod").innerHTML = Array.from({ length: periods }, (_, i) =>
    `<option value="${i + 1}">الفترة ${i + 1} (الحصص ${i * n + 1}–${(i + 1) * n})</option>`).join("");
  $("payPeriod").value = p;

  const periodLessons = R.lessons.filter(l => l.no > (p - 1) * n && l.no <= p * n);
  const done = periodLessons.length >= n;
  $("payTitle").innerHTML = `${GRADES[grade]} — الفترة ${p} ` + (done
    ? `<span class="badge ok">اكتملت</span>`
    : `<span class="badge warn">جارية: ${periodLessons.length} من ${n} حصة</span>`);

  const rows = payRows(grade, p, periodLessons, R, price, n);
  const totalDue = rows.reduce((t, r) => t + r.due, 0);
  const paid = rows.reduce((t, r) => t + (r.pay ? Number(r.pay.amount) : 0), 0);
  const remaining = rows.filter(r => !r.pay).reduce((t, r) => t + r.due, 0);
  $("payTotals").innerHTML = `
    <div class="stat"><div class="k">إجمالي المستحق</div><div class="v">${money(totalDue)}</div></div>
    <div class="stat"><div class="k">المدفوع</div><div class="v" style="color:var(--ok)">${money(paid)}</div><div class="s">${rows.filter(r => r.pay).length} طالب</div></div>
    <div class="stat"><div class="k">المتبقي</div><div class="v" style="color:var(--err)">${money(remaining)}</div><div class="s">${rows.filter(r => !r.pay).length} طالب</div></div>`;

  const q = $("paySearch").value.trim().toLowerCase(), f = $("payFilter").value;
  const shown = rows.filter(r =>
    (!f || (f === "paid") === !!r.pay) &&
    (!q || r.s.full_name.toLowerCase().includes(q) || String(r.s.code).includes(q)));

  $("payBody").innerHTML = shown.length
    ? shown.map(r => `<tr>
        <td>${esc(r.s.full_name)}</td>
        <td class="num"><b>${r.s.code}</b></td>
        <td>${r.held}</td><td><b class="m-yes">${r.present}</b></td><td><b class="m-no">${r.absent}</b></td>
        <td><b>${money(r.due)}</b></td>
        <td>${r.pay
          ? `<span class="badge ok">✅ تم الدفع ${money(r.pay.amount)}</span>
             <span class="paid-at">${fmtDateTime(r.pay.paid_at)}${r.pay.paid_by ? " · " + esc(r.pay.paid_by) : ""}
             <button class="btn ghost sm" style="min-height:26px;padding:0 8px" data-unpay="${r.pay.id}" type="button">إلغاء</button></span>`
          : `<button class="btn sm" data-pay="${r.s.code}" data-amount="${r.due}" type="button">تأكيد الدفع</button>`}</td></tr>`).join("")
    : `<tr><td colspan="7" class="empty">مفيش طلاب</td></tr>`;
}

function payRows(grade, p, periodLessons, R, price, n) {
  const payments = new Map(state.gradeData[grade].payments.filter(x => x.period_no === p).map(x => [x.student_code, x]));
  return gradeStudents(grade).map(s => {
    const r = R.rowFor(s, periodLessons);
    return { s, ...r, due: Math.round(price / n * r.present), pay: payments.get(s.code) };
  });
}

$("payPeriod").addEventListener("change", () => { state.period[state.grade] = Number($("payPeriod").value); renderPayments(); });
$("payFilter").addEventListener("change", renderPayments);
$("paySearch").addEventListener("input", renderPayments);

$("payBody").addEventListener("click", async e => {
  const grade = state.grade, p = state.period[grade], data = state.gradeData[grade];
  const pay = e.target.closest("button[data-pay]");
  const unpay = e.target.closest("button[data-unpay]");

  if (pay) {
    const code = Number(pay.dataset.pay), amount = Number(pay.dataset.amount);
    const s = state.byCode.get(code);
    if (!confirm(`تأكيد دفع ${money(amount)} من ${s?.full_name || code}؟`)) return;
    pay.disabled = true;
    const { data: row, error } = await sb.rpc("confirm_payment", { p_code: code, p_grade: grade, p_period: p, p_amount: amount });
    if (error) { pay.disabled = false; return toast(errText(error)); }
    data.payments = data.payments.filter(x => !(x.student_code === code && x.period_no === p)).concat(row);
    toast("✅ تم تسجيل الدفع");
    renderPayments();
  }

  if (unpay) {
    if (!confirm("تلغي تسجيل الدفع للطالب ده؟")) return;
    const id = Number(unpay.dataset.unpay);
    const { error } = await sb.from("payments").delete().eq("id", id);
    if (error) return toast(errText(error));
    data.payments = data.payments.filter(x => x.id !== id);
    renderPayments();
  }
});

$("settingsForm").addEventListener("submit", async e => {
  e.preventDefault();
  const price = Number($("setPrice").value), count = Number($("setCount").value);
  if (!(price >= 0)) return toast("اكتب سعر صحيح");
  if (!(count >= 1)) return toast("عدد الحصص لازم يبقى 1 على الأقل");
  const { data, error } = await sb.from("grade_settings")
    .upsert({ grade: state.grade, price, lessons_count: Math.round(count) }).select().single();
  if (error) return toast(errText(error));
  state.settings[state.grade] = data;
  toast("الإعدادات اتحفظت");
  $("setPrice").blur(); $("setCount").blur();
  renderPayments();
});

$("payPdf").addEventListener("click", () => {
  const grade = state.grade, data = state.gradeData[grade];
  if (!data) return;
  const set = state.settings[grade] || { price: 0, lessons_count: 12 };
  const price = Number(set.price) || 0, n = Number(set.lessons_count) || 12, p = state.period[grade] || 1;
  const R = buildRegister(data);
  const periodLessons = R.lessons.filter(l => l.no > (p - 1) * n && l.no <= p * n);
  const rows = payRows(grade, p, periodLessons, R, price, n);
  const body = `<table><thead><tr><th>#</th><th>الطالب</th><th>الكود</th><th>عدد الحصص</th><th>حضر</th><th>غاب</th><th>المبلغ المستحق</th><th>حالة الدفع</th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr><td>${i + 1}</td><td class="name">${esc(r.s.full_name)}</td><td>${r.s.code}</td>
      <td>${r.held}</td><td>${r.present}</td><td>${r.absent}</td>
      <td><b>${money(r.due)}</b></td>
      <td>${r.pay ? `✅ دفع ${money(r.pay.amount)}<span class="paid-at">${fmtDateTime(r.pay.paid_at)}</span>` : "⬜ لم يدفع"}</td></tr>`).join("") +
    `</tbody></table>`;
  const total = rows.reduce((t, r) => t + r.due, 0), paid = rows.reduce((t, r) => t + (r.pay ? Number(r.pay.amount) : 0), 0);
  printDoc(`${GRADES[grade]} – الحسابات (الفترة ${p})`,
    `سعر الصف ${price} ج · ${n} حصة · الحصص المنتهية ${periodLessons.length} · إجمالي المستحق ${money(total)} · المدفوع ${money(paid)} · تاريخ التقرير: ${fmtDateTime(new Date())}`,
    body, "");
});

// ================= PDF =================
function printDoc(title, subtitle, bodyHTML, extraClass, landscape = true) {
  const w = window.open("", "_blank");
  if (!w) return toast("المتصفح منع فتح صفحة التقرير، اسمح بالنوافذ المنبثقة (popups)");
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 10mm; }
  body { font-family: Cairo, sans-serif; color: #000; margin: 0; padding: 12px; }
  h1 { font-size: 18px; margin: 0; } .sub { color: #555; font-size: 12px; margin-bottom: 10px; }
  h3 { font-size: 14px; margin: 16px 0 6px; } h3 small { color: #555; font-weight: 600; margin-inline-start: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  body.small table { font-size: 9px; }
  tr { page-break-inside: avoid; } thead { display: table-header-group; }
  th, td { border: 1px solid #999; padding: 3px 5px; text-align: center; }
  th { background: #eef1f7; } td.name { text-align: right; white-space: nowrap; }
  th small { display: block; font-weight: 600; color: #555; font-size: 9px; }
  .summary { display: flex; gap: 10px; margin: 0 0 12px; }
  .summary div { flex: 1; border: 1px solid #ccc; border-radius: 8px; padding: 6px 10px; text-align: center; font-size: 12px; }
  .summary b { display: block; font-size: 20px; }
  .summary .yes b { color: #0a7a3f; } .summary .no b { color: #c43131; }
  tr.absent td { background: #fdecee; }
  .m-yes { color: #0a7a3f; font-weight: 800; } .m-grp { display: block; color: #555; font-size: 8px; font-weight: 600; }
  .m-no { color: #c43131; font-weight: 800; } .m-na { color: #999; }
  .legend { font-size: 11px; color: #555; } .legend span { margin-inline-end: 14px; }
  .paid-at { display: block; color: #555; font-size: 9px; } .empty { color: #777; }
  .table-wrap { overflow: visible; } .reg-group { page-break-inside: auto; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body class="${extraClass}"><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>${bodyHTML}
<script>document.fonts.ready.then(() => setTimeout(() => print(), 300));<\/script></body></html>`);
  w.document.close();
}

// ================= الطلاب =================
const gradeOpts = Object.entries(GRADES).map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
$("fGrade").insertAdjacentHTML("beforeend", gradeOpts);

// تحديث خيارات الشعب حسب الصف المختار في الفلتر
function updateFilterTracks() {
  const gradeVal = $("fGrade").value;
  const trackSelect = $("fTrack");
  if (!trackSelect) return;

  const tracks = gradeVal ? (TRACKS_BY_GRADE[gradeVal] || []) : ["أدبي", "علمي علوم", "علمي رياضة"];
  trackSelect.innerHTML = '<option value="">كل الشعب</option>' + tracks.map(t => `<option value="${t}">${t}</option>`).join("");
}

$("fGrade").addEventListener("change", () => {
  updateFilterTracks();
  renderStudents();
});

function filteredStudents() {
  const q = $("search").value.trim().toLowerCase();
  const g = $("fGrade").value, t = $("fTrack").value;
  return state.students.filter(s =>
    (!g || s.grade === Number(g)) &&
    (!t || s.track === t) &&
    (!q || s.full_name.toLowerCase().includes(q) || String(s.code).includes(q) || s.phone.includes(q))
  );
}

function renderStudents() {
  const list = filteredStudents();
  $("studentsCount").textContent = `(${list.length})`;
  $("studentsBody").innerHTML = list.length
    ? list.map(s => `<tr>
        <td class="num"><b>${s.code}</b></td><td>${esc(s.full_name)}</td><td class="num">${esc(s.phone)}</td>
        <td>${esc(s.gender)}</td><td>${esc(s.governorate)}</td><td>${GRADES[s.grade]}</td><td>${esc(s.track)}</td>
        <td>${new Date(s.created_at).toLocaleDateString("ar-EG-u-nu-latn")}</td></tr>`).join("")
    : `<tr><td colspan="8" class="empty">مفيش طلاب</td></tr>`;
}

["search", "fTrack"].forEach(id => $(id)?.addEventListener("input", renderStudents));

$("csvBtn")?.addEventListener("click", () => {
  const head = ["الكود", "الاسم", "الهاتف", "النوع", "المحافظة", "الصف", "الشعبة", "تاريخ التسجيل"];
  const rows = filteredStudents().map(s => [s.code, s.full_name, s.phone, s.gender, s.governorate, GRADES[s.grade], s.track,
    new Date(s.created_at).toLocaleDateString("en-GB")]);
  const csv = [head, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `students-${cairoToday()}.csv`;
  a.click();
});

// ================= طباعة كروت الـ QR لجميع الطلاب =================
$("qrPdfBtn")?.addEventListener("click", () => {
  const list = filteredStudents();

  if (!list || !list.length) {
    return toast("مفيش طلاب متاحين للطباعة حسب الفلتر الحالي");
  }

  const printArea = $("printQrArea");
  if (!printArea) return;
  printArea.innerHTML = "";

  // تقسيم الطلاب لصفحات A4 (كل صفحة تحتوي على 4 كروت متوسطة الحجم)
  const pageSize = 4;
  for (let i = 0; i < list.length; i += pageSize) {
    const pageStudents = list.slice(i, i + pageSize);
    const pageDiv = document.createElement("div");
    pageDiv.className = "qr-page";

    pageStudents.forEach(st => {
      // توليد الـ QR Code
      const qr = qrcode(0, "M");
      qr.addData(String(st.code));
      qr.make();
      const qrSvg = qr.createSvgTag({ cellSize: 5, margin: 1, scalable: true });

      const trackText = Number(st.grade) === 1 ? "عام" : (st.track || "عام");
      const gradeText = GRADES[st.grade] || st.grade;

      const card = document.createElement("div");
      card.className = "qr-card-print";
      card.innerHTML = `
        <div class="card-head">
          <img src="icons/icon-96.png" alt="غيابك" width="32" height="32">
          <h3>منصة غيابك</h3>
        </div>
        <div class="student-name">${esc(st.full_name)}</div>
        <div class="card-code">كود الطالب: <b>${esc(st.code)}</b></div>
        <div class="qr-svg-wrap">${qrSvg}</div>
        <div class="card-info">
          <div class="info-grid">
            <div class="info-item">
              <span>الصف</span>
              <b>${esc(gradeText)}</b>
            </div>
            <div class="info-item">
              <span>الشعبة</span>
              <b>${esc(trackText)}</b>
            </div>
          </div>
        </div>
      `;
      pageDiv.appendChild(card);
    });

    printArea.appendChild(pageDiv);
  }

  // تفعيل وضع الطباعة
  document.body.classList.add("printing-qr");

  setTimeout(() => {
    window.print();
  }, 300);
});

// تنظيف الشاشة وإعادة وضع الصفحة للوضع الطبيعي بعد إنهاء الطباعة
window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-qr");
  const printArea = $("printQrArea");
  if (printArea) printArea.innerHTML = "";
});