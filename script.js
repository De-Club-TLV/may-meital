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
            const response = await fetch(SUBMIT_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                },
                body: canonical,
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error('Submission failed: ' + response.status + ' ' + text.slice(0, 200));
            }

            // Success: show redirect panel, then send the user to Arbox.
            formSection.classList.add('redirecting');
            redirectPanel.hidden = false;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            setTimeout(() => {
                window.location.href = ARBOX_PURCHASE_URL;
            }, 800);
        } catch (err) {
            console.error(err);
            btnLabel.textContent = 'נסו שוב';
            submitBtn.disabled = false;
            setTimeout(() => {
                btnLabel.textContent = originalLabel;
            }, 2500);
        }
    });
})();
