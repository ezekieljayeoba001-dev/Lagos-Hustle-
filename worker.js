
const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

const encoder = new TextEncoder();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

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

  const sig = btoa(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return payload + "." + sig;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return json({
      success: true,
      message: "Lagos Hustle backend is working!"
    });
  }

  if (path === "/api/db-test") {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all();

    return json({
      success: true,
      message: "Database connected!",
      tables: result.results
    });
  }

  // REGISTER
  if (path === "/api/register" && request.method === "POST") {
    if (!env.DB) {
      console.error("Registration failed: DB binding is missing.");
      return json({ error: "Database is not configured." }, 500);
    }

    if (!env.SESSION_SECRET) {
      console.error("Registration failed: SESSION_SECRET is missing.");
      return json({
        error: "Server session secret is not configured."
      }, 500);
    }

    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid JSON request." }, 400);
    }

    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return json({
        error: "Username must be 3–20 letters, numbers or underscores."
      }, 400);
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254
    ) {
      return json({ error: "Enter a valid email address." }, 400);
    }

    if (password.length < 10 || password.length > 128) {
      return json({
        error: "Password must be 10–128 characters."
      }, 400);
    }

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltText = btoa(
        String.fromCharCode(...new Uint8Array(salt))
      );

      const passwordHash = await hashPassword(password, salt);
      const storedHash = saltText + ":" + passwordHash;

      const result = await env.DB.prepare(
        "INSERT INTO players (username, email, password_hash) VALUES (?, ?, ?)"
      ).bind(username, email, storedHash).run();

      const playerId = result.meta.last_row_id;

      try {
        await env.DB.prepare(
          "INSERT INTO player_progress (player_id, money, level, experience) VALUES (?, 0, 1, 0)"
        ).bind(playerId).run();
      } catch (error) {
        console.error(
          "Registration progress creation failed:",
          errorMessage(error)
        );

        // Remove only the newly inserted player if setup fails.
        try {
          await env.DB.prepare(
            "DELETE FROM players WHERE id = ?"
          ).bind(playerId).run();
        } catch (cleanupError) {
          console.error(
            "Registration cleanup failed:",
            errorMessage(cleanupError)
          );
        }

        return json({
          error: "Could not initialize your player profile. Please try again."
        }, 500);
      }

      const token = await signSession(playerId, env.SESSION_SECRET);

      return json({
        success: true,
        message: "Account created!",
        player: {
          id: playerId,
          username,
          money: 0,
          level: 1,
          experience: 0
        },
        token
      }, 201);

    } catch (error) {
      const detail = errorMessage(error);
      console.error("Registration failed:", detail);

      if (
        /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(detail)
      ) {
        return json({
          error: "That username or email is already registered."
        }, 409);
      }

      return json({
        error: "Registration failed. Check Worker logs."
      }, 500);
    }
  }

  // LOGIN
  if (path === "/api/login" && request.method === "POST") {
    if (!env.DB) {
      console.error("Login failed: DB binding is missing.");
      return json({ error: "Database is not configured." }, 500);
    }

    if (!env.SESSION_SECRET) {
      console.error("Login failed: SESSION_SECRET is missing.");
      return json({
        error: "Server session secret is not configured."
      }, 500);
    }

    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid JSON request." }, 400);
    }

    const identity = String(body.identity || "").trim();
    const password = String(body.password || "");

    if (!identity || !password) {
      return json({
        error: "Enter your username/email and password."
      }, 400);
    }

    try {
      const player = await env.DB.prepare(
        `SELECT id, username, password_hash
         FROM players
         WHERE username = ? COLLATE NOCASE
            OR email = ? COLLATE NOCASE`
      ).bind(identity, identity).first();

      if (!player) {
        return json({ error: "Invalid login details." }, 401);
      }

      const parts = String(player.password_hash || "").split(":");

      if (parts.length !== 2) {
        return json({
          error: "Account needs a password reset."
        }, 500);
      }

      const salt = Uint8Array.from(
        atob(parts[0]),
        c => c.charCodeAt(0)
      );

      const candidate = await hashPassword(password, salt);

      if (candidate !== parts[1]) {
        return json({ error: "Invalid login details." }, 401);
      }

      const progress = await env.DB.prepare(
        `SELECT money, level, experience
         FROM player_progress
         WHERE player_id = ?`
      ).bind(player.id).first();

      const token = await signSession(
        player.id,
        env.SESSION_SECRET
      );

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

    } catch (error) {
      console.error("Login failed:", errorMessage(error));

      return json({
        error: "Login failed. Check Worker logs."
      }, 500);
    }
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleRequest(request, env);
      } catch (error) {
        console.error(
          "Unhandled API error:",
          errorMessage(error)
        );

        return json({
          error: "Server error. Check Worker logs."
        }, 500);
      }
    }

    if (!env.ASSETS) {
      return new Response("Static assets binding is missing.", {
        status: 500
      });
    }

    return env.ASSETS.fetch(request);
  }
};
