// The auth plate.
//
// One form, one failure mode, no theatre. A wrong password draws a 1px oxide
// rule under the field and says so in twelve point. It never shakes.

import { login, me, ApiError } from "./api.js";
import { qs, setLoading } from "./ui.js";

const form = qs("#login-form");
const email = qs("#email");
const password = qs("#password");
const submit = qs("#login-submit");
const error = qs("#login-error");
const stage = qs("#auth-page");

// The page shell needs to centre the plate. If the stylesheet already provides
// that, leave it alone — this is only a floor, applied through CSSOM so the
// strict style-src policy is never in question.
function ensureStageLayout() {
  if (!stage) return;
  const computed = window.getComputedStyle(stage);
  if (computed.display === "grid" || computed.display === "flex") return;
  stage.style.setProperty("display", "grid");
  stage.style.setProperty("place-items", "center");
  stage.style.setProperty("min-block-size", "100vh");
  stage.style.setProperty("padding-inline", "var(--s-24)");
  stage.style.setProperty("padding-block", "var(--s-40)");
  stage.style.setProperty("background", "var(--bg-000)");
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  email.setAttribute("aria-invalid", "true");
  password.setAttribute("aria-invalid", "true");
  password.focus();
  password.select();
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
  email.removeAttribute("aria-invalid");
  password.removeAttribute("aria-invalid");
}

for (const field of [email, password]) {
  field.addEventListener("input", () => {
    if (!error.hidden) clearError();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const address = email.value.trim();
  const secret = password.value;

  if (!address || !secret) {
    showError("Enter your email and password.");
    return;
  }

  setLoading(submit, true, "Signing in");
  try {
    await login(address, secret);
    // Owe the app one title card. It is consumed on arrival and never
    // re-issued, because a title card that repeats is an annoyance.
    try {
      window.sessionStorage.setItem("meridian.breath", "1");
    } catch {
      /* Private browsing can refuse storage. The app simply opens without it. */
    }
    window.location.replace("/app");
  } catch (err) {
    setLoading(submit, false, "Sign in");
    const message =
      err instanceof ApiError
        ? err.message
        : "Could not reach the server. Check your connection and try again.";
    showError(message);
  }
});

ensureStageLayout();

// An already-authenticated visitor should not be asked to sign in twice.
me()
  .then((payload) => {
    if (payload && payload.authenticated) window.location.replace("/app");
  })
  .catch(() => {
    /* An unreachable session endpoint is not a reason to block the form. */
  });
