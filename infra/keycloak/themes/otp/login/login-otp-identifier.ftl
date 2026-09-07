<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true subtitleKey="loginAccountSubtitle"; section>
<!-- template: login-otp-identifier.ftl -->

    <#if section="header">
        ${msg("otpIdentifierTitle")}
    <#elseif section="form">
        <form id="kc-otp-identifier-form"
              class="${properties.kcFormClass!}"
              action="${url.loginAction}"
              method="post"
              novalidate="novalidate">
            <div class="${properties.kcFormGroupClass!} bd-id-group">
                <label for="identifier" class="${properties.kcLabelClass!}">${msg("otpIdentifierLabel")}</label>
                <div class="bd-id-field" data-state="empty">
                    <span class="bd-id-icon" aria-hidden="true">
                        <svg class="bd-id-icon-default" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M3 7l9 6 9-6"/></svg>
                        <svg class="bd-id-icon-mail" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M3 7l9 6 9-6"/></svg>
                        <svg class="bd-id-icon-phone" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>
                    </span>
                    <input tabindex="1"
                           id="identifier"
                           name="identifier"
                           type="text"
                           class="${properties.kcInputClass!} bd-id-input"
                           autofocus
                           autocomplete="username"
                           inputmode="text"
                           spellcheck="false"
                           autocapitalize="off"
                           value="${(identifier!'')}"
                           placeholder="${msg('otpIdentifierPlaceholder')}"
                           aria-describedby="bd-id-hint"/>
                    <button type="button" class="bd-id-clear" id="bd-id-clear" aria-label="Clear" tabindex="-1" hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div id="bd-id-hint" class="bd-id-hint" aria-live="polite"></div>
            </div>
            <div class="${properties.kcFormGroupClass!}">
                <button tabindex="2"
                        class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!} bd-submit"
                        name="submit"
                        id="kc-submit"
                        type="submit">
                    <span class="bd-submit-label">${msg('otpIdentifierContinue')}</span>
                    <span class="bd-spinner" aria-hidden="true"></span>
                </button>
            </div>
        </form>

        <script>
        (function () {
            var form = document.getElementById('kc-otp-identifier-form');
            var input = document.getElementById('identifier');
            var field = form ? form.querySelector('.bd-id-field') : null;
            var hint = document.getElementById('bd-id-hint');
            var clearBtn = document.getElementById('bd-id-clear');
            var submitBtn = document.getElementById('kc-submit');
            if (!form || !input || !field || !submitBtn) return;

            var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            var PHONE_RE = /^\+?[0-9\-\s]{7,18}$/;

            function detect(v) {
                var t = (v || '').trim();
                if (!t) return 'empty';
                if (t.indexOf('@') !== -1) return EMAIL_RE.test(t) ? 'email' : 'email-partial';
                if (/^[+0-9]/.test(t)) return PHONE_RE.test(t) ? 'phone' : 'phone-partial';
                return 'unknown';
            }

            function update() {
                var state = detect(input.value);
                field.setAttribute('data-state', state);
                if (clearBtn) clearBtn.hidden = !input.value;
                // Gate Continue: enabled only for a complete, valid email or phone.
                submitBtn.disabled = !(state === 'email' || state === 'phone');
                if (!hint) return;
                if (state === 'email' || state === 'phone' || state === 'empty') {
                    hint.textContent = '';
                    hint.classList.remove('is-warn');
                } else if (state === 'email-partial') {
                    hint.textContent = 'Looks like an email — finish typing to continue.';
                    hint.classList.add('is-warn');
                } else if (state === 'phone-partial') {
                    hint.textContent = 'Mobile number looks incomplete.';
                    hint.classList.add('is-warn');
                } else {
                    hint.textContent = 'Enter a valid email or mobile number.';
                    hint.classList.add('is-warn');
                }
            }

            input.addEventListener('input', update);
            input.addEventListener('blur', update);
            update();

            if (clearBtn) {
                clearBtn.addEventListener('click', function () {
                    input.value = '';
                    input.focus();
                    update();
                });
            }

            form.addEventListener('submit', function (e) {
                if (!input.value.trim()) {
                    e.preventDefault();
                    input.focus();
                    if (hint) {
                        hint.textContent = 'Please enter your email or mobile number.';
                        hint.classList.add('is-warn');
                    }
                    return;
                }
                submitBtn.disabled = true;
                submitBtn.classList.add('is-loading');
                input.readOnly = true;
            });
        })();
        </script>
    </#if>
</@layout.registrationLayout>
