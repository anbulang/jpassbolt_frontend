// KeyFileButton.tsx — a small, OPTIONAL "select a key file (.asc)" affordance.
//
// Lets the user pick a local OpenPGP private-key FILE instead of pasting its
// armored text. It is purely additive: on load it just hands the file's text to
// `onLoaded`, which the consuming page wires to the SAME state setter its paste
// textarea already uses. Pasting keeps working unchanged.
//
// SECURITY: the chosen file is read ENTIRELY IN-BROWSER via FileReader. It is
// never uploaded — nothing leaves the device. This component is purely
// presentational: no network, no crypto.

import { useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';

interface KeyFileButtonProps {
  /** Called with the file's trimmed text once it is read in-browser. */
  onLoaded: (armored: string) => void;
  /** Visible button label (default "选择密钥文件"). */
  label?: string;
}

export default function KeyFileButton({ onLoaded, label }: KeyFileButtonProps) {
  const { t } = useTranslation('components');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the SAME file can be re-picked later (the change event won't fire
    // again for an identical selection otherwise).
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    try {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          // FileReader reads the file locally — it never leaves this browser.
          const text = String(reader.result ?? '').trim();
          // We always pass the text through; the consuming page validates the
          // armored "-----BEGIN PGP" shape on submit (no special handling here).
          onLoaded(text);
        } catch {
          /* ignore — paste remains available as the fallback */
        }
      };
      reader.onerror = () => {
        /* ignore — paste remains available as the fallback */
      };
      reader.readAsText(file, 'UTF-8');
    } catch {
      /* ignore — paste remains available as the fallback */
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".asc,.key,.txt,.gpg,.pgp,application/pgp-keys"
        onChange={handleChange}
        style={{ display: 'none' }}
      />
      <button type="button" className="btn sm" onClick={() => inputRef.current?.click()}>
        <Upload size={15} /> {label ?? t('keyFile.select')}
      </button>
    </>
  );
}
