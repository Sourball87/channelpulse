import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthGate, AuthProvider } from '@/components/auth-provider';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppLayout } from '@/components/layout';
import { FilterProvider } from '@/context/filter-context';
import NotFound from '@/pages/not-found';

import Dashboard from '@/pages/dashboard';
import Insights from '@/pages/insights';
import Explorer from '@/pages/explorer';
import Trends from '@/pages/trends';
import Alerts from '@/pages/alerts';
import UploadCenter from '@/pages/upload';
import AdminSettings from '@/pages/admin';
import ScanbackClaims from '@/pages/scanback';

const queryClient = new QueryClient();

function Router() {
  return (
    <FilterProvider>
      <AppLayout>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/sell-through" component={Dashboard} />
          <Route path="/insights" component={Insights} />
          <Route path="/explorer" component={Explorer} />
          <Route path="/trends" component={Trends} />
          <Route path="/alerts" component={Alerts} />
          <Route path="/upload" component={UploadCenter} />
          <Route path="/scanback" component={ScanbackClaims} />
          <Route path="/admin" component={AdminSettings} />
          <Route component={NotFound} />
        </Switch>
      </AppLayout>
    </FilterProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider delayDuration={150}>
          <AuthGate>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <Router />
            </WouterRouter>
          </AuthGate>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
