/**
 * The only client-side script in Ballot Fix, served at /static/webauthn.js and
 * loaded only by the sign-in and account pages (ported from job-radar).
 *
 * It exists because WebAuthn can't be done any other way: `navigator.credentials`
 * is a browser API. Everything else works with scripting off, and so do these
 * pages: the passkey buttons ship `hidden` and this file is what reveals them.
 * No script, no passkey button, and the password form is right there.
 *
 * It only moves bytes between the server and the authenticator; the server
 * decides everything. Endpoint URLs come from data attributes so they carry the
 * app's mount prefix (BASE_PATH).
 *
 * (Not linted: Deno's linter targets a server runtime, the opposite of here.)
 */
"use strict";

(() => {
  const toBytes = (value) => {
    let padded = value.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4 !== 0) padded += "=";
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const toBase64Url = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const post = async (url, body) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = { error: "The server sent something unreadable." };
    }
    if (!response.ok) throw new Error(payload.error || "Something went wrong.");
    return payload;
  };

  const say = (node, message) => {
    if (!node) return;
    node.textContent = message;
    node.hidden = message === "";
  };

  /** A cancelled or timed-out prompt is NotAllowedError; that isn't a failure worth explaining. */
  const cancelled = (error) => error && error.name === "NotAllowedError";

  const supported = typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials === "object";

  /* -------------------------------------------------- signing in ---------- */

  const signIn = document.querySelector("[data-passkey-signin]");
  if (signIn && supported) {
    const status = document.querySelector("[data-passkey-status]");
    signIn.hidden = false;

    signIn.addEventListener("click", async () => {
      signIn.disabled = true;
      say(status, "");
      try {
        const options = await post(signIn.dataset.options);
        options.challenge = toBytes(options.challenge);
        const assertion = await navigator.credentials.get({ publicKey: options });
        const result = await post(signIn.dataset.finish, {
          credentialId: assertion.id,
          clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
          authenticatorData: toBase64Url(assertion.response.authenticatorData),
          signature: toBase64Url(assertion.response.signature),
          userHandle: assertion.response.userHandle
            ? toBase64Url(assertion.response.userHandle)
            : null,
          next: signIn.dataset.next || "",
        });
        window.location.assign(result.redirect);
      } catch (error) {
        signIn.disabled = false;
        say(
          status,
          cancelled(error)
            ? "Passkey sign-in was cancelled."
            : (error && error.message) || "Passkey sign-in failed.",
        );
      }
    });
  }

  /* -------------------------------------------------- registering --------- */

  const register = document.querySelector("[data-passkey-register]");
  if (register) {
    const status = document.querySelector("[data-passkey-register-status]");
    const unsupported = document.querySelector("[data-passkey-unsupported]");

    if (!supported) {
      if (unsupported) unsupported.hidden = false;
    } else {
      register.hidden = false;
      const labelField = document.querySelector("[data-passkey-label]");
      if (labelField) labelField.hidden = false;

      register.addEventListener("click", async () => {
        register.disabled = true;
        say(status, "");
        try {
          const options = await post(register.dataset.options);
          options.challenge = toBytes(options.challenge);
          options.user.id = toBytes(options.user.id);
          options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({
            ...credential,
            id: toBytes(credential.id),
          }));

          const credential = await navigator.credentials.create({ publicKey: options });
          const label = labelField ? labelField.querySelector("input") : null;
          const result = await post(register.dataset.finish, {
            label: label ? label.value : "",
            credentialId: credential.id,
            clientDataJSON: toBase64Url(credential.response.clientDataJSON),
            attestationObject: toBase64Url(credential.response.attestationObject),
            transports: credential.response.getTransports
              ? credential.response.getTransports()
              : [],
          });
          window.location.assign(result.redirect);
        } catch (error) {
          register.disabled = false;
          if (error && error.name === "InvalidStateError") {
            say(status, "This device already has a passkey for Ballot Fix.");
          } else if (cancelled(error)) {
            say(status, "Registration was cancelled.");
          } else {
            say(status, (error && error.message) || "Couldn't register this device.");
          }
        }
      });
    }
  }
})();
