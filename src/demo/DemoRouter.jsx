import React, { useEffect, useState } from 'react';
import { readDemoPolicy } from './demoApi';
import { preloadPlotlyRenderer } from '../components/Plot';
import DemoLoading, { AppLoading } from './DemoLoading';

const App = React.lazy(() => import('../App'));
const DemoExperience = React.lazy(() => import('./DemoExperience'));

export default function DemoRouter() {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    readDemoPolicy().then(value => {
      if (!active) return;
      if (value.demoMode && value.guidedDemoEnabled !== false) preloadPlotlyRenderer().catch(() => {});
      setPolicy(value);
    })
      .catch(() => { if (active) setError('The app could not connect to the analysis server. Please try again.'); });
    return () => { active = false; };
  }, [attempt]);
  if (!policy) return <AppLoading error={error} message="Connecting to the analysis server…" onRetry={() => { setError(''); setAttempt(value => value + 1); }} />;
  if (policy.demoMode && policy.guidedDemoEnabled !== false) return <React.Suspense fallback={<DemoLoading />}><DemoExperience /></React.Suspense>;
  return <React.Suspense fallback={<AppLoading />}><App /></React.Suspense>;
}
