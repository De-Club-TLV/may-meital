(() => {
    const form = document.querySelector('form.signup-form');
    if (!form) return;

    const phoneInput = document.getElementById('phone');
    const emailInput = document.getElementById('email');
    const phoneField = phoneInput.closest('.field');
    const emailField = emailInput.closest('.field');
    const phoneError = document.getElementById('phone-error');
    const emailError = document.getElementById('email-error');

    const formSection = document.querySelector('.form-section');
    const redirectPanel = document.querySelector('.redirect-panel');
    const redirectLink = document.getElementById('redirect-link');
    const closedPanel = document.querySelector('.closed-panel');
    const submitBtn = form.querySelector('.submit-btn');
    const btnLabel = submitBtn.querySelector('.btn-label');

    // Hardcoded purchase URL (Arbox shop). Public anyway, no need for env wiring.
    const ARBOX_PURCHASE_URL = 'https://3ol1r9sb.web.arboxapp.com/shop/490714?whitelabel=DeClub&lang=he&location=21230';

    const SUBMIT_ENDPOINT = '/.netlify/functions/submit-signup';
    const STATUS_ENDPOINT = '/.netlify/functions/form-status';

    // Shared HMAC secret with the Netlify Function env var MAY_MEITAL_HMAC_SECRET.
    // Browser can see this; real anti-abuse lives at the edge. Same tradeoff as Hot Form.
    const HMAC_SECRET = '16a1036dc8bf33c39aea4f986ba8fcc5054b12ef4d2e4a7a27bdbe4bd46818b5';

    redirectLink.href = ARBOX_PURCHASE_URL;

    /* ---------- Capacity check on load ---------- */

    (async () => {
        try {
            const res = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.open === false) {
                formSection.classList.add('closed');
                closedPanel.hidden = false;
            }
        } catch (_) {
            // Fail open: if status check breaks, let signups continue.
        }
    })();

    /* ---------- Validators ---------- */

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    // Israeli mobile: 9 digits starting with 5 (after stripping a leading 0).
    // Accepts user input with hyphens/spaces and an optional leading 0.
    function normalizeIsraeliMobile(raw) {
        const digits = raw.replace(/\D/g, '');
        return digits.startsWith('0') ? digits.slice(1) : digits;
    }

    const validatePhone = (touched = true) => {
        const raw = phoneInput.value.trim();
        if (!raw) {
            if (touched) showError(phoneField, phoneError, 'נא להזין מספר טלפון.');
            return false;
        }
        const normalized = normalizeIsraeliMobile(raw);
        const valid = /^5\d{8}$/.test(normalized);
        if (!valid) {
            if (touched) showError(phoneField, phoneError, 'נא להזין מספר נייד ישראלי תקין.');
            return false;
        }
        clearError(phoneField, phoneError);
        return true;
    };

    const validateEmail = (touched = true) => {
        const val = emailInput.value.trim();
        if (!val) {
            if (touched) showError(emailField, emailError, 'נא להזין כתובת אימייל.');
            return false;
        }
        const valid = emailRe.test(val);
        if (!valid) {
            if (touched) showError(emailField, emailError, 'נא להזין כתובת אימייל תקינה.');
            return false;
        }
        clearError(emailField, emailError);
        return true;
    };

    function showError(fieldEl, errorEl, msg) {
        fieldEl.classList.add('invalid');
        errorEl.textContent = msg;
        errorEl.hidden = false;
    }

    function clearError(fieldEl, errorEl) {
        fieldEl.classList.remove('invalid');
        errorEl.hidden = true;
    }

    /* ---------- Real-time validation ---------- */

    phoneInput.addEventListener('blur', () => validatePhone(true));
    phoneInput.addEventListener('input', () => {
        if (phoneField.classList.contains('invalid')) validatePhone(true);
    });

    emailInput.addEventListener('blur', () => validateEmail(true));
    emailInput.addEventListener('input', () => {
        if (emailField.classList.contains('invalid')) validateEmail(true);
    });

    /* ---------- HMAC ---------- */

    function sortKeys(val) {
        if (Array.isArray(val)) return val.map(sortKeys);
        if (val && typeof val === 'object') {
            const out = {};
            for (const k of Object.keys(val).sort()) out[k] = sortKeys(val[k]);
            return out;
        }
        return val;
    }

    function canonicalJson(obj) {
        return JSON.stringify(sortKeys(obj));
    }

    async function hmacSha256Hex(secret, message) {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            enc.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
        return Array.from(new Uint8Array(sig))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /* ---------- Submit ---------- */

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const phoneOk = validatePhone(true);
        const emailOk = validateEmail(true);

        if (!form.checkValidity() || !phoneOk || !emailOk) {
            form.reportValidity();
            if (!phoneOk) phoneInput.focus();
            else if (!emailOk) emailInput.focus();
            return;
        }

        const originalLabel = btnLabel.textContent;
        submitBtn.disabled = true;
        btnLabel.textContent = 'שולח…';

        const fd = new FormData(form);
        const phoneNormalized = normalizeIsraeliMobile((fd.get('phone') || '').toString());
        const payload = {
            first_name: (fd.get('first_name') || '').toString().trim(),
            last_name: (fd.get('last_name') || '').toString().trim(),
            phone: `+972${phoneNormalized}`,
            phone_country: 'il',
            email: (fd.get('email') || '').toString().trim(),
        };

        try {
            const canonical = canonicalJson(payload);
            const signature = await hmacSha256Hex(HMAC_SECRET, canonical);

            // Retry on transient failures (network drops, 5xx). The function
            // also retries internally and dedupes via Idempotency-Key, so even
            // if a previous attempt half-succeeded we will not double-create.
            const ATTEMPTS = 3;
            const BACKOFFS_MS = [400, 1200];
            let response = null;
            let lastStatus = 0;
            let lastText = '';
            for (let i = 0; i < ATTEMPTS; i++) {
                if (i > 0) await new Promise((r) => setTimeout(r, BACKOFFS_MS[i - 1] || 2000));
                try {
                    response = await fetch(SUBMIT_ENDPOINT, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Webhook-Signature': signature,
                        },
                        body: canonical,
                    });
                    if (response.ok) break;
                    lastStatus = response.status;
                    lastText = await response.text().catch(() => '');
                    // 4xx (except 408) means we sent something wrong, retrying
                    // won't help — give up immediately.
                    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
                        break;
                    }
                } catch (e) {
                    // Network error — fall through and retry
                    response = null;
                    lastStatus = 0;
                    lastText = e && e.message ? e.message : String(e);
                }
            }

            if (!response || !response.ok) {
                throw new Error('Submission failed after retries: ' + lastStatus + ' ' + lastText.slice(0, 200));
            }

            // Success: show redirect panel, then send the user to Arbox.
            formSection.classList.add('redirecting');
            redirectPanel.hidden = false;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            setTimeout(() => {
                window.location.href = ARBOX_PURCHASE_URL;
            }, 800);
        } catch (err) {
            // Critical: do NOT redirect to Arbox on failure. We must never let
            // someone pay without a Pending entry on Monday — the Arbox cron
            // won't be able to match them and they'd be stuck off-funnel.
            console.error(err);
            btnLabel.textContent = 'נסו שוב';
            submitBtn.disabled = false;
            setTimeout(() => {
                btnLabel.textContent = originalLabel;
            }, 2500);
        }
    });
})();

/* ---------- Parallax on the yoga photo ---------- */
// Subtle vertical shift of the image inside its fixed-height window as the
// element scrolls through the viewport. Pure rAF, no library.
(() => {
    const win = document.querySelector('.parallax-window');
    const img = win?.querySelector('.parallax-img');
    if (!win || !img) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    // Range of vertical shift in px (each direction). Image is min-height 130%
    // of the window so we have ~15% of slack on each side to slide through.
    const RANGE = 60;

    let frameRequested = false;
    function update() {
        frameRequested = false;
        const rect = win.getBoundingClientRect();
        const viewportH = window.innerHeight || document.documentElement.clientHeight;
        // progress: 0 when window's top edge is at viewport bottom (entering),
        //          1 when window's bottom edge is at viewport top (leaving).
        const total = viewportH + rect.height;
        const traveled = viewportH - rect.top;
        const progress = Math.max(0, Math.min(1, traveled / total));
        // Shift from -RANGE (entering) to +RANGE (leaving), centered at 0.
        const shift = (progress - 0.5) * 2 * RANGE;
        img.style.transform = `translate3d(-50%, ${-shift}px, 0)`;
    }

    function onScrollOrResize() {
        if (!frameRequested) {
            frameRequested = true;
            requestAnimationFrame(update);
        }
    }

    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });
    update();
})();
