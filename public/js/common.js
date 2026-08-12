// Shared helpers used across pages.

export async function getConfig() {
  const res = await fetch("/api/config");
  return res.json();
}

// --- Auth helpers ---------------------------------------------------------

export async function getMe() {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    return data.user || null;
  } catch {
    return null;
  }
}

export async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
}

// Fills a header element (id="authNav") with login state: name + menu, or a
// "Log in" link. Call on every page that includes the auth nav slot.
export async function renderAuthNav() {
  const slot = document.getElementById("authNav");
  if (!slot) return;
  const user = await getMe();
  slot.innerHTML = "";
  if (!user) {
    slot.append(el("a", { href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}` }, "Log in"));
    return;
  }
  const home = user.role === "handyman" ? "/pro.html" : "/account.html";
  slot.append(el("a", { href: home, style: "font-weight:700" }, user.name ? user.name.split(" ")[0] : "Account"));
  const out = el("a", { href: "#", style: "margin-left:14px" }, "Log out");
  out.addEventListener("click", async (e) => {
    e.preventDefault();
    await logout();
    location.href = "/";
  });
  slot.append(out);
}

export function money(n) {
  return "$" + Number(n).toFixed(2);
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

const AVATAR_COLORS = [
  "#f5871f", "#1f6feb", "#17924a", "#8e44ad",
  "#e0559c", "#0aa2c0", "#d9720c", "#5b6ee1",
];

export function avatar(el, name) {
  const initials = (name || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  let hash = 0;
  for (const c of name || "") hash = (hash + c.charCodeAt(0)) % AVATAR_COLORS.length;
  el.textContent = initials;
  el.style.background = AVATAR_COLORS[hash];
}

// Returns an inline-styled <span class="stars"> string for a given rating.
export function starsHtml(rating) {
  const full = Math.round(rating || 0);
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += i <= full ? "★" : '<span class="empty">★</span>';
  }
  return `<span class="stars">${out}</span>`;
}

// Builds a round avatar: uses the uploaded photo if present, else colored initials.
export function avatarEl(h, style = "") {
  if (h && h.photoUrl) {
    return el("img", {
      class: "avatar",
      src: h.photoUrl,
      alt: h.name || "",
      style: `object-fit:cover;${style}`,
    });
  }
  const node = el("div", { class: "avatar", style });
  avatar(node, (h && h.name) || "");
  return node;
}

// Downscales/compresses an image File in the browser to a small JPEG data URL,
// so uploads stay tiny and fast regardless of the original photo size.
export function compressImage(file, max = 512, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > max) {
          height = Math.round((height * max) / width);
          width = max;
        } else if (height >= width && height > max) {
          width = Math.round((width * max) / height);
          height = max;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (typeof v === "function" && k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}
