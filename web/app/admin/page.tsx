import AdminContent from './AdminContent';

export const metadata = { title: '데이터 수집 현황' };

export default function AdminPage() {
  return (
    <main className="max-w-[860px] mx-auto px-6 py-10">
      <AdminContent />
    </main>
  );
}
