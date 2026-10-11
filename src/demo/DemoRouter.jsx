import React, { useEffect, useState } from 'react';
import { readDemoPolicy } from './demoApi';
import DemoExperience, { DemoLoading } from './DemoExperience';

const App = React.lazy(() => import('../App'));

export default function DemoRouter() {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    readDemoPolicy().then(value => { if (active) setPolicy(value); })
      .catch(() => { if (active) setError('The demo could not connect. Please try again.'); });
    return () => { active = false; };
  }, [attempt]);
  if (!policy) return <DemoLoading error={error} onRetry={() => { setError(''); setAttempt(value => value + 1); }} />;
  if (policy.demoMode && policy.guidedDemoEnabled !== false) return <DemoExperience />;
  return <React.Suspense fallback={<DemoLoading />}><App /></React.Suspense>;
}
