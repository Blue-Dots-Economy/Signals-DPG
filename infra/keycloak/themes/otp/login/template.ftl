<#--
    `subtitleKey` — message key for the line under the page title, or "" for
    no line at all (the default).

    It has to be per-page. This layout is the theme's ONLY template.ftl, so
    every page rendered by this theme goes through it — not just the four
    templates in this directory, but every page inherited from the parent
    theme too (page-expired, error, and so on). A subtitle hardcoded here
    therefore appeared on all of them, and it only ever described the
    identifier step: the SMS/email code screens told the reader to "Continue
    with email or mobile to receive a verification code" directly above the
    boxes for a code they had already received.

    Defaulting to "" rather than to the old string is deliberate: a page that
    says nothing about how it wants to be introduced gets no subtitle, so an
    inherited page cannot silently pick up copy written for a different step.
-->
<#macro registrationLayout displayInfo=false displayMessage=true displayRequiredFields=false showAnotherWayIfPresent=true bodyClass="" subtitleKey="">
    <#-- Loop variable `section` is bound by the caller's `<@layout.registrationLayout; section>` syntax. -->
<!DOCTYPE html>
<html lang="${locale.currentLanguageTag!'en'}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="robots" content="noindex,nofollow">
    <title>${msg("loginTitle",(realm.displayName!''))}</title>

    <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/img/brand/${properties.brandLogoSlug!'blue-dot'}/favicon.svg">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap">
    <link rel="stylesheet" href="${url.resourcesPath}/css/blue-dots.css">
    <#-- Palette overrides come after the static CSS so per-network env
         vars win over the file's :root defaults. Static file stays
         network-agnostic; this block carries the colour swap. -->
    <style>
      :root {
        --bd-primary:      ${properties.brandPrimary!'#4f46e5'};
        --bd-primary-600:  ${properties.brandPrimaryDark!'#4338ca'};
        --bd-primary-500:  ${properties.brandPrimary500!'#6366f1'};
        --bd-primary-100:  ${properties.brandPrimary100!'#e0e7ff'};
        --bd-primary-50:   ${properties.brandPrimary50!'#eef2ff'};
        --bd-font-sans:    ${properties.brandFontSans!"'Inter', system-ui, sans-serif"};
        --bd-font-heading: ${properties.brandFontHeading!"'Plus Jakarta Sans', system-ui, sans-serif"};
        --bd-font-body:    ${properties.brandFontBody!"'Inter', system-ui, sans-serif"};
      }
      .bd-hero-glow {
        background:
          radial-gradient(700px 500px at 75% 25%, var(--bd-primary-500) 0%, transparent 60%),
          radial-gradient(600px 480px at 15% 85%, var(--bd-primary) 0%, transparent 60%) !important;
        opacity: 0.22;
      }
    </style>

    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
</head>
<body class="bd-body">
    <div class="bd-shell">
        <aside class="bd-hero" aria-hidden="true">
            <canvas id="bd-hero-canvas" class="bd-hero-canvas"></canvas>
            <div class="bd-hero-glow"></div>
            <div class="bd-hero-copy">
                <div class="bd-hero-brand">
                    <span class="bd-hero-wordmark">${properties.brandShortName!'Aggregator'}</span>
                    <span class="bd-hero-strapline">Seeded by EkStep Foundation</span>
                </div>
            </div>
        </aside>

        <main class="bd-pane">
            <div class="bd-card">
                <header class="bd-brand">
                    <img class="bd-brand-logo"
                         src="${url.resourcesPath}/img/brand/${properties.brandLogoSlug!'blue-dot'}/logo.png"
                         alt="${properties.brandShortName!'Aggregator'}"/>
                </header>

                <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                    <div class="bd-alert bd-alert-${message.type}">
                        <#if message.type = 'success'><span aria-hidden="true">✓</span></#if>
                        <#if message.type = 'warning'><span aria-hidden="true">!</span></#if>
                        <#if message.type = 'error'><span aria-hidden="true">×</span></#if>
                        <#if message.type = 'info'><span aria-hidden="true">i</span></#if>
                        <span>${kcSanitize(message.summary)?no_esc}</span>
                    </div>
                </#if>

                <a href="javascript:history.back()" class="bd-back" aria-label="Back">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="19" y1="12" x2="5" y2="12"></line>
                        <polyline points="12 19 5 12 12 5"></polyline>
                    </svg>
                    Back
                </a>

                <h2 class="bd-title"><#nested "header"></h2>
                <#if subtitleKey?has_content>
                    <p class="bd-subtitle">${msg(subtitleKey)}</p>
                </#if>

                <div class="bd-form-area">
                    <#nested "form">
                </div>

                <#if displayInfo>
                    <div class="bd-info">
                        <#nested "info">
                    </div>
                </#if>

                <#if auth?has_content && auth.showTryAnotherWayLink() && showAnotherWayIfPresent>
                    <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" class="bd-try-another">
                        <input type="hidden" name="tryAnotherWay" value="on"/>
                        <button type="submit" class="bd-link-btn">${msg("doTryAnotherWay")}</button>
                    </form>
                </#if>
            </div>
        </main>
    </div>
    <script src="${url.resourcesPath}/js/blue-dots.js" defer></script>
</body>
</html>
</#macro>
