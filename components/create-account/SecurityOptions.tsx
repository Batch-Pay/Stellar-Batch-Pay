"use client";

interface SecurityOptionsProps {
  twoFactor: boolean;
  securityNotifications: boolean;
  agreeTerms: boolean;
  marketingEmails: boolean;
  onTwoFactorChange: (v: boolean) => void;
  onSecurityNotificationsChange: (v: boolean) => void;
  onAgreeTermsChange: (v: boolean) => void;
  onMarketingEmailsChange: (v: boolean) => void;
  termsError?: string;
}

interface CheckboxItemProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}

function CheckboxItem({ id, checked, onChange, children }: CheckboxItemProps) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 cursor-pointer group"
    >
      <div className="relative mt-0.5 flex-shrink-0">
        <input
          type="checkbox"
          id={id}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
        />
        <div
          className={`w-4 h-4 bg-white border-2 transition-all duration-200 flex items-center justify-center
            ${checked ? "bg-[#00d4a0] border-white" : "border-white group-hover:border-gray-400 bg-transparent"}`}
        >
          {checked && (
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
              <path
                d="M1 4L3.5 6.5L9 1"
                stroke="black"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>
      <span className="text-sm text-gray-300 leading-relaxed">{children}</span>
    </label>
  );
}

export default function SecurityOptions({
  twoFactor,
  securityNotifications,
  agreeTerms,
  marketingEmails,
  onTwoFactorChange,
  onSecurityNotificationsChange,
  onAgreeTermsChange,
  onMarketingEmailsChange,
  termsError,
}: SecurityOptionsProps) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-semibold text-white">Security Options</h3>

      <div className="flex flex-col gap-3">
        <CheckboxItem id="twoFactor" checked={twoFactor} onChange={onTwoFactorChange}>
          Enable Two-Factor Authentication (Recommended)
        </CheckboxItem>
        <CheckboxItem
          id="securityNotifs"
          checked={securityNotifications}
          onChange={onSecurityNotificationsChange}
        >
          Receive security notifications
        </CheckboxItem>
      </div>

      <div className="border-t border-gray-800 pt-4 flex flex-col gap-3">
        <CheckboxItem id="terms" checked={agreeTerms} onChange={onAgreeTermsChange}>
          I agree to the{" "}
          <a href="#" className="text-white underline underline-offset-2 hover:text-[#00D98B]">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="#" className="text-white underline underline-offset-2 hover:text-[#00D98B]">
            Privacy Policy
          </a>
        </CheckboxItem>
        {termsError && (
          <p className="text-xs text-red-400 -mt-1">{termsError}</p>
        )}
        <CheckboxItem
          id="marketing"
          checked={marketingEmails}
          onChange={onMarketingEmailsChange}
        >
          I&apos;d like to receive product updates and marketing emails (Optional)
        </CheckboxItem>
      </div>
    </div>
  );
}