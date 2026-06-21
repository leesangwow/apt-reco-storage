'use client';

import { Suspense } from 'react';
import RecommendContent from './RecommendContent';

export default function RecommendPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F5F5F1]" />}>
      <RecommendContent />
    </Suspense>
  );
}
