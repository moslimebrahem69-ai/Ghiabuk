const STORE_KEY = "ghiyabak_student";
const THEME_KEY = "ghiyabak_theme";
const $ = id => document.getElementById(id);
let student = null;   // البيانات الخاصّة بالطالب

// ----- إدارة الثيم (Light / Dark Mode) -----
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "light";
  document.documentElement.setAttribute("data-theme", saved);
}
initTheme();

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", current);
  localStorage.setItem(THEME_KEY, current);
}

document.querySelectorAll("#themeToggle, .theme-toggle").forEach(btn => {
  btn.addEventListener("click", toggleTheme);
});

// ----- تعبئة قائمة المحافظات -----
for (const id of ["rGov", "pGov"]) {
  const el = $(id);
  if (el) el.insertAdjacentHTML("beforeend", GOVERNORATES.map(g => `<option>${g}</option>`).join(""));
}

// ----- التحكم في إظهار وملء خيارات الشعبة بناءً على الصف -----
function updateTrackVisibility(prefix) {
  const gradeVal = $(prefix + "Grade")?.value;
  const trackField = $(prefix + "TrackField");
  const trackSelect = $(prefix + "Track");

  if (!trackSelect) return;

  const tracks = (typeof TRACKS_BY_GRADE !== "undefined" && TRACKS_BY_GRADE[gradeVal]) || [];

  if (gradeVal === "1") {
    // الصف الأول الثانوي: إخفاء حقل الشعبة وتثبيت القيمة على "عام"
    if (trackField) trackField.hidden = true;
    trackSelect.required = false;
    trackSelect.innerHTML = '<option value="عام">عام</option>';
    trackSelect.value = "عام";
  } else if (gradeVal === "2" || gradeVal === "3") {
    // الصف الثاني أو الثالث الثانوي: إظهار الشعبة وتعبئة القوائم الخاصة بالصف
    if (trackField) trackField.hidden = false;
    trackSelect.required = true;

    const currentVal = trackSelect.value;
    trackSelect.innerHTML = '<option value="">اختار الشعبة</option>' + 
      tracks.map(t => `<option value="${t}">${t}</option>`).join("");

    if (tracks.includes(currentVal)) {
      trackSelect.value = currentVal;
    } else {
      trackSelect.value = "";
    }
  } else {
    // لو لم يتم اختيار صف بعد
    if (trackField) trackField.hidden = false;
    trackSelect.required = true;
    trackSelect.innerHTML = '<option value="">اختار الشعبة</option>';
  }
}

// مراقبة تغيير الصف في شاشة التسجيل وشاشة تعديل البيانات
["rGrade", "pGrade"].forEach(id => {
  const el = $(id);
  if (el) {
    const prefix = id.charAt(0);
    el.addEventListener("change", () => updateTrackVisibility(prefix));
  }
});

// ----- أدوات -----
function normDigits(s) {
  return String(s).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\s/g, "");
}

function setMsg(id, text, type = "err") {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "msg " + (text ? type : "");
}
const showMsg = (text, type) => setMsg("authMsg", text, type);

function toast(text) {
  const t = $("toast");
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

async function withBusy(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "لحظة...";
  try { await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}

function saveStudent(s) {
  student = s;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
}

function checkFields(f) {
  if (f.name.split(" ").filter(Boolean).length < 2) return "اكتب الاسم بالكامل (اسمين على الأقل)";
  if (!/^01[0125]\d{8}$/.test(f.phone)) return "رقم الهاتف لازم يكون 11 رقم ويبدأ بـ 010 أو 011 أو 012 أو 015";
  if (!f.gender) return "اختار النوع";
  if (!f.gov) return "اختار المحافظة";
  if (!f.grade) return "اختار الصف";
  if (f.grade !== "1" && !f.track) return "اختار الشعبة";
  return null;
}

function readFields(p) {
  const gradeVal = $(p + "Grade")?.value;
  return {
    name: $(p + "Name")?.value.trim() || "",
    phone: normDigits($(p + "Phone")?.value || ""),
    gender: document.querySelector(`input[name=${p}Gender]:checked`)?.value,
    gov: $(p + "Gov")?.value || "",
    grade: gradeVal,
    track: gradeVal === "1" ? "عام" : ($(p + "Track")?.value || ""),
  };
}

// ================= تسجيل / دخول =================
document.querySelectorAll("#authView .tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#authView .tab").forEach(t => t.classList.toggle("active", t === tab));
    $("registerForm").hidden = tab.dataset.tab !== "register";
    $("loginForm").hidden = tab.dataset.tab !== "login";
    showMsg("");
  });
});

$("registerForm")?.addEventListener("submit", e => {
  e.preventDefault();
  const f = readFields("r");
  const pass = $("rPass")?.value || "", pass2 = $("rPass2")?.value || "";
  const problem = checkFields(f);
  if (problem) return showMsg(problem);
  if (pass.length < 6) return showMsg("كلمة السر لازم تكون 6 حروف على الأقل");
  if (pass !== pass2) return showMsg("كلمة السر وتأكيدها مش زي بعض");

  withBusy(e.target, async () => {
    showMsg("");
    const { data, error } = await sb.rpc("register_student", {
      p_full_name: f.name, p_phone: f.phone, p_gender: f.gender, p_governorate: f.gov,
      p_grade: Number(f.grade), p_track: f.track, p_password: pass
    });
    if (error) return showMsg(errText(error));
    saveStudent(data);
    enterArea("guide", true);
  });
});

$("loginForm")?.addEventListener("submit", e => {
  e.preventDefault();
  const phone = normDigits($("lPhone")?.value || "");
  const pass = $("lPass")?.value || "";
  if (!phone || !pass) return showMsg("اكتب رقم الهاتف وكلمة السر");

  withBusy(e.target, async () => {
    showMsg("");
    const { data, error } = await sb.rpc("login_student", { p_phone: phone, p_password: pass });
    if (error) return showMsg(errText(error));
    saveStudent(data);
    enterArea("card", false);
  });
});

$("logoutBtn")?.addEventListener("click", () => {
  try { localStorage.removeItem(STORE_KEY); } catch {}
  location.reload();
});

// ================= مساحة الطالب =================
function enterArea(view, isNew) {
  $("authView").hidden = true;
  $("studentArea").hidden = false;
  $("logoutBtn").hidden = false;
  document.body.classList.add("has-bottom-nav");
  renderCard(isNew);
  renderGuide(isNew);
  showSView(view);
}

function showSView(view) {
  document.querySelectorAll("#sNav button").forEach(b => b.classList.toggle("active", b.dataset.sview === view));
  document.querySelectorAll(".sview").forEach(v => (v.hidden = v.id !== "sview-" + view));
  if (view === "profile") fillProfile();
  window.scrollTo({ top: 0 });
}

document.querySelectorAll("#sNav button").forEach(b => b.addEventListener("click", () => showSView(b.dataset.sview)));
document.addEventListener("click", e => {
  const go = e.target.closest("[data-go]");
  if (go) showSView(go.dataset.go);
});

// ----- الكارنيه -----
function renderCard(isNew) {
  const s = student;
  if (!s) return;
  const first = s.full_name.split(" ")[0];
  $("welcome").textContent = isNew ? `مبروك يا ${first}، حسابك اتعمل 🎉` : `أهلاً يا ${first}`;
  $("cAvatar").textContent = s.full_name.trim().charAt(0);
  $("cName").textContent = s.full_name;
  $("cCode").textContent = s.code;
  $("cGrade").textContent = GRADES[s.grade];
  $("cTrack").textContent = Number(s.grade) === 1 ? "عام" : s.track;
  $("cGov").textContent = s.governorate;
  $("cGender").textContent = s.gender;

  $("qr").innerHTML = makeQR(s.code).createSvgTag({ cellSize: 8, margin: 2, scalable: true });

  const list = (s.attendance || []).filter(a => a && typeof a === "object");
  $("attCount").textContent = `(${list.length})`;
  $("attList").innerHTML = list.length
    ? list.map(a => `<span class="pill">الحصة ${a.lesson_no} · ${esc(fmtDate(a.day))} · ${esc(a.group_name)}</span>`).join("")
    : `<span class="muted">لسه مفيش حضور مسجل</span>`;
}

$("printBtn")?.addEventListener("click", () => window.print());

function makeQR(code) {
  const qr = qrcode(0, "M");
  qr.addData(String(code));
  qr.make();
  return qr;
}

$("dlBtn")?.addEventListener("click", () => {
  const code = String(student.code);
  const qr = makeQR(code);
  const n = qr.getModuleCount(), cell = 16, pad = cell * 3, size = n * cell + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size + 60;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
  ctx.font = "bold 40px Cairo, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(code, size / 2, size + 30);
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `qr-${code}.png`;
  a.click();
});

// ----- صفحة الشرح -----
function renderGuide(isNew) {
  const s = student;
  if (!s) return;
  const first = s.full_name.split(" ")[0];
  $("guideTitle").textContent = isNew ? `مبروك يا ${first}، حسابك اتعمل 🎉` : "إزاي منصة غيابك شغالة";
  $("guideSub").textContent = isNew
    ? "قبل ما تبدأ، ده شرح سريع للمنصة ماشية إزاي"
    : "كل اللي محتاج تعرفه في دقيقة";
  $("gCode").textContent = s.code;
  $("guideCta").textContent = isNew ? "يلا، شوف الكارنيه بتاعي" : "شوف الكارنيه بتاعي";
  renderGuideGroups(s.grade);
}

async function renderGuideGroups(grade) {
  const intro = `انت في <b>${esc(GRADES[grade])}</b>. مش لازم تلتزم بمجموعة معينة، احضر مع <b>أي مجموعة</b> في صفك، وحضورك بيتحسب عادي.`;
  $("gGroup").innerHTML = intro;
  const { data, error } = await sb.from("groups")
    .select("name, start_time, days").eq("grade", grade).eq("active", true).order("start_time");
  if (error || !data?.length || student?.grade !== grade) return;
  $("gGroup").innerHTML = intro + `<span class="g-times">${data.map(g =>
    `<span class="g-time"><b>${fmtTime(g.start_time)}</b>${g.days?.length ? " · " + esc(fmtDays(g.days)) : ""}</span>`).join("")}</span>`;
}

// ----- بياناتي -----
function fillProfile() {
  const s = student;
  if (!s) return;
  $("pCode").textContent = s.code;
  $("pName").value = s.full_name;
  $("pPhone").value = s.phone;
  document.querySelectorAll("input[name=pGender]").forEach(r => (r.checked = r.value === s.gender));
  $("pGov").value = s.governorate;
  $("pGrade").value = s.grade;
  updateTrackVisibility("p");
  $("pTrack").value = s.track;
  $("pNewPass").value = "";
  $("pNewPass2").value = "";
  $("pCurPass").value = "";
  $("passBox").open = false;
  setMsg("profileMsg", "");
}

$("profileForm")?.addEventListener("submit", e => {
  e.preventDefault();
  const f = readFields("p");
  const newPass = $("pNewPass")?.value || "", newPass2 = $("pNewPass2")?.value || "", cur = $("pCurPass")?.value || "";
  const problem = checkFields(f);
  if (problem) return setMsg("profileMsg", problem);
  if (newPass || newPass2) {
    if (newPass.length < 6) return setMsg("profileMsg", "كلمة السر الجديدة لازم تكون 6 حروف على الأقل");
    if (newPass !== newPass2) return setMsg("profileMsg", "كلمة السر الجديدة وتأكيدها مش زي بعض");
  }
  if (!cur) {
    $("pCurPass")?.focus();
    return setMsg("profileMsg", "اكتب كلمة السر الحالية عشان تحفظ التعديلات");
  }

  withBusy(e.target, async () => {
    setMsg("profileMsg", "");
    const { data, error } = await sb.rpc("update_student", {
      p_phone: student.phone, p_password: cur,
      p_full_name: f.name, p_new_phone: f.phone, p_gender: f.gender, p_governorate: f.gov,
      p_grade: Number(f.grade), p_track: f.track,
      p_new_password: newPass || null
    });
    if (error) return setMsg("profileMsg", errText(error));
    saveStudent(data);
    renderCard(false);
    renderGuide(false);
    fillProfile();
    setMsg("profileMsg", "✅ التعديلات اتحفظت", "ok");
    toast("بياناتك اتحدثت");
  });
});

let refreshing = false;
async function refreshStudent() {
  if (!student?.token || refreshing) return;
  refreshing = true;
  try {
    const { data, error } = await sb.rpc("get_student", { p_token: student.token });
    if (error) {
      if (/انتهت الجلسة/.test(error.message)) {
        try { localStorage.removeItem(STORE_KEY); } catch {}
        student = null;
        $("studentArea").hidden = true;
        $("authView").hidden = false;
        $("logoutBtn").hidden = true;
        document.body.classList.remove("has-bottom-nav");
        document.querySelector('#authView .tab[data-tab="login"]')?.click();
        showMsg(error.message);
      }
      return;
    }
    saveStudent(data);
    renderCard(false);
    renderGuide(false);
  } finally { refreshing = false; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStudent();
});

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  if (saved?.code) { student = saved; enterArea("card", false); refreshStudent(); }
} catch {}