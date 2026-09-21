import { BrowserRouter, Route, Routes } from "react-router";

import { Layout } from "@/components/layout";
import { ActivityPage } from "@/pages/activity";
import { ClientsPage } from "@/pages/clients";
import { KeysPage } from "@/pages/keys";
import { LogDetailPage } from "@/pages/log-detail";
import { LogsPage } from "@/pages/logs";
import { OverviewPage } from "@/pages/overview";
import { ProvidersPage } from "@/pages/providers";
import { RoutingPage } from "@/pages/routing";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="routing" element={<RoutingPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="logs/:id" element={<LogDetailPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
