import { useTranslation } from 'react-i18next';

export default function VosSignIn() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">MCPHub</h1>
      <p>{t('vos.signInRequired')}</p>
      <button className="rounded-md border px-4 py-2" onClick={() => window.location.reload()}>
        {t('vos.retry')}
      </button>
    </main>
  );
}
