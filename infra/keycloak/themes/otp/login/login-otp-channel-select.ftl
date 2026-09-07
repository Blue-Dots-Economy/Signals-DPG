<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<@layout.registrationLayout displayMessage=true subtitleKey="loginAccountSubtitle"; section>
<!-- template: login-otp-channel-select.ftl -->

    <#if section="header">
        ${msg("otpChannelSelectTitle")}
    <#elseif section="form">
        <form id="kc-otp-channel-select-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <ul class="${properties.kcSelectAuthListClass!}" role="list">
                    <li class="${properties.kcSelectAuthListItemWrapperClass!}">
                        <button type="submit" name="channel" value="email"
                                class="${properties.kcSelectAuthListItemClass!}" style="width:100%;border:none;background:none;cursor:pointer;text-align:left;">
                            <div class="pf-v5-c-data-list__item-content">
                                <div class="${properties.kcSelectAuthListItemIconClass!}">
                                    <i class="fa fa-envelope" aria-hidden="true"></i>
                                </div>
                                <div class="${properties.kcSelectAuthListItemBodyClass!}">
                                    <h2 class="${properties.kcSelectAuthListItemHeadingClass!}">
                                        ${msg("otpChannelEmail")}
                                    </h2>
                                </div>
                                <div class="${properties.kcSelectAuthListItemDescriptionClass!}">
                                    ${msg("otpChannelEmailHelp")}
                                </div>
                            </div>
                            <div class="${properties.kcSelectAuthListItemFillClass!}">
                                <i class="${properties.kcSelectAuthListItemArrowIconClass!}" aria-hidden="true"></i>
                            </div>
                        </button>
                    </li>
                    <li class="${properties.kcSelectAuthListItemWrapperClass!}">
                        <button type="submit" name="channel" value="sms"
                                class="${properties.kcSelectAuthListItemClass!}" style="width:100%;border:none;background:none;cursor:pointer;text-align:left;">
                            <div class="pf-v5-c-data-list__item-content">
                                <div class="${properties.kcSelectAuthListItemIconClass!}">
                                    <i class="fa fa-mobile" aria-hidden="true"></i>
                                </div>
                                <div class="${properties.kcSelectAuthListItemBodyClass!}">
                                    <h2 class="${properties.kcSelectAuthListItemHeadingClass!}">
                                        ${msg("otpChannelSms")}
                                    </h2>
                                </div>
                                <div class="${properties.kcSelectAuthListItemDescriptionClass!}">
                                    ${msg("otpChannelSmsHelp")}
                                </div>
                            </div>
                            <div class="${properties.kcSelectAuthListItemFillClass!}">
                                <i class="${properties.kcSelectAuthListItemArrowIconClass!}" aria-hidden="true"></i>
                            </div>
                        </button>
                    </li>
                </ul>
            </div>
        </form>
    </#if>
</@layout.registrationLayout>
