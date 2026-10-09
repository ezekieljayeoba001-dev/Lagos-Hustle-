const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

const encoder = new TextEncoder();

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 310000,
      hash: "SHA-256"
    },
    key,
    256
  );

  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function signSession(playerId, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const payload = btoa(JSON.stringify({
    playerId,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  }));

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return payload + "." + sig;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return json({ success: true, message: "Lagos Hustle backend is working!" });
  }

  if (path === "/api/db-test") {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all();
    return json({ success: true, message: "Database connected!", tables: result.results });
  }

  if (path === "/api/register" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Invalid JSON" }, 400);

    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return json({ error: "Username must be 3–20 letters, numbers or underscores." }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json({ error: "Enter a valid email address." }, 400);
    }
    if (password.length < 10 || password.length > 128) {
      return json({ error: "Password must be 10–128 characters." }, 400);
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltText = btoa(String.fromCharCode(...salt));
    const passwordHash = await hashPassword(password, salt);
    const storedHash = saltText + ":" + passwordHash;

    try {
      const result = await env.DB.prepare(
        "INSERT INTO players (username, email, password_hash) VALUES (?, ?, ?)"
      ).bind(username, email, storedHash).run();

      const playerId = result.meta.last_row_id;

      await env.DB.prepare(
        "INSERT INTO player_progress (player_id, money, level, experience) VALUES (?, 0, 1, 0)"
      ).bind(playerId).run();

      if (!env.SESSION_SECRET) {
        return json({ error: "Server session secret is not configured." }, 500);
      }

      const token = await signSession(playerId, env.SESSION_SECRET);
      return json({
        success: true,
        message: "Account created!",
        player: { id: playerId, username, money: 0, level: 1, experience: 0 },
        token
      }, 201);
    } catch {
      return json({ error: "That username or email may already be registered." }, 409);
    }
  }

  if (path === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Invalid JSON" }, 400);

    const identity = String(body.identity || "").trim();
    const password = String(body.password || "");

    if (!identity || !password) {
      return json({ error: "Enter your username/email and password." }, 400);
    }

    const player = await env.DB.prepare(
      "SELECT id, username, password_hash FROM players WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE"
    ).bind(identity, identity).first();

    if (!player) return json({ error: "Invalid login details." }, 401);

    const parts = player.password_hash.split(":");
    if (parts.length !== 2) return json({ error: "Account needs a password reset." }, 500);

    const salt = Uint8Array.from(atob(parts[0]), c => c.charCodeAt(0));
    const candidate = await hashPassword(password, salt);

    if (candidate !== parts[1]) {
      return json({ error: "Invalid login details." }, 401);
    }

    if (!env.SESSION_SECRET) {
      return json({ error: "Server session secret is not configured." }, 500);
    }

    const progress = await env.DB.prepare(
      "SELECT money, level, experience FROM player_progress WHERE player_id = ?"
    ).bind(player.id).first();

    const token = await signSession(player.id, env.SESSION_SECRET);

    return json({
      success: true,
      message: "Login successful!",
      player: {
        id: player.id,
        username: player.username,
        money: progress?.money ?? 0,
        level: progress?.level ?? 1,
        experience: progress?.experience ?? 0
      },
      token
    });
  }

  return json({ error: "Not found" }, 404);
}

export default { async fetch(request, env) { const url = new URL(request.url);
if (url.pathname.startsWith("/api/")) {
  try {
    return await handleRequest(request, env);
  } catch {
    return json({ error: "Server error. Please try again." }, 500);
  }
}
return env.ASSETS.fetch(request);
} }; 
