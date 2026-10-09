package admin_test

import (
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
)

// scheduledRoutes is the PUT /routing payload the dashboard sends: a night window
// in Singapore time, and a plan route that uses other models inside it.
func scheduledRoutes() map[string]any {
	return map[string]any{
		"routings": []any{
			map[string]any{"id": "plan", "label": "Plan", "models": []string{"day-model"}, "windows": map[string]any{"night": []string{"night-model", "day-model"}}},
			map[string]any{"id": "execute", "label": "Execute", "models": []string{"day-flash"}},
			map[string]any{"id": "utility", "label": "Utility", "models": []string{"day-flash"}},
			map[string]any{"id": "chat", "label": "Chat", "models": []string{"day-flash"}},
		},
		"schedule": map[string]any{
			"timezone": "Asia/Singapore",
			"windows":  []any{map[string]any{"id": "night", "label": "Off-nights", "start": "22:00", "end": "08:00"}},
		},
	}
}

func effectivePlan(t *testing.T, out map[string]any) []string {
	t.Helper()
	effective, ok := out["effective"].(map[string]any)
	if !ok {
		t.Fatalf("no effective models in %#v", out)
	}
	var models []string
	for _, m := range effective["plan"].([]any) {
		models = append(models, m.(string))
	}
	return models
}

func TestRoutingScheduleIsSavedAndReportedBeforeTheWindow(t *testing.T) {
	// 12:00 UTC is 20:00 in Singapore: two hours before the night window starts.
	x := setup(t, nil)
	code, out := request(t, x.h, "PUT", "/routing", scheduledRoutes())
	checkStatus(t, code, 200, out)

	status := out["schedule"].(map[string]any)
	if status["timezone"] != "Asia/Singapore" || status["active"] != "" || status["nextActive"] != "night" {
		t.Fatalf("status = %#v", status)
	}
	if next := status["nextChange"].(string); !strings.HasPrefix(next, "2026-10-05T22:00:00+08:00") {
		t.Fatalf("nextChange = %q", next)
	}
	if got := effectivePlan(t, out); !reflect.DeepEqual(got, []string{"day-model"}) {
		t.Fatalf("effective plan = %v", got)
	}

	// Stored on disk and in the live config, in the shape the dashboard reads back.
	data, err := os.ReadFile(x.path)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := config.ParseBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Routing.Schedule == nil || saved.Routing.Schedule.Windows[0].Label != "Off-nights" {
		t.Fatalf("schedule not saved: %+v", saved.Routing.Schedule)
	}
	if got := saved.Routing.Routings[0].Windows["night"]; !reflect.DeepEqual(got, []string{"night-model", "day-model"}) {
		t.Fatalf("night list = %v", got)
	}
	code, state := request(t, x.h, "GET", "/state", nil)
	checkStatus(t, code, 200, state)
	if state["schedule"] == nil || effectivePlan(t, state)[0] != "day-model" {
		t.Fatalf("state does not carry the schedule: %#v", state["schedule"])
	}
	if state["config"].(map[string]any)["routing"].(map[string]any)["schedule"] == nil {
		t.Fatal("config.routing.schedule missing from state")
	}
}

func TestRoutingScheduleUsesTheWindowModelsAtNight(t *testing.T) {
	// 15:00 UTC is 23:00 in Singapore, inside the window.
	x := setupAt(t, nil, time.Date(2026, 10, 5, 15, 0, 0, 0, time.UTC))
	code, out := request(t, x.h, "PUT", "/routing", scheduledRoutes())
	checkStatus(t, code, 200, out)
	status := out["schedule"].(map[string]any)
	// After the window nothing applies, which is sent as an absent nextActive.
	if status["active"] != "night" || status["activeLabel"] != "Off-nights" || status["nextActive"] != nil {
		t.Fatalf("status = %#v", status)
	}
	if got := effectivePlan(t, out); !reflect.DeepEqual(got, []string{"night-model", "day-model"}) {
		t.Fatalf("effective plan at night = %v", got)
	}
	// The saved list for the route stays the day list: the window never overwrites it.
	if got := x.config.Routing.Routings[0].Models; !reflect.DeepEqual(got, []string{"day-model"}) {
		t.Fatalf("stored plan models = %v", got)
	}
}

func TestRoutingScheduleValidationAndRemoval(t *testing.T) {
	x := setup(t, nil)
	bad := scheduledRoutes()
	bad["schedule"] = map[string]any{"timezone": "Mars/Olympus"}
	code, out := request(t, x.h, "PUT", "/routing", bad)
	checkStatus(t, code, 400, out)
	if x.config.Routing.Schedule != nil {
		t.Fatal("a rejected schedule must not change the live config")
	}

	code, out = request(t, x.h, "PUT", "/routing", scheduledRoutes())
	checkStatus(t, code, 200, out)

	// Sending only routings leaves the schedule alone.
	code, out = request(t, x.h, "PUT", "/routing", map[string]any{"routings": scheduledRoutes()["routings"]})
	checkStatus(t, code, 200, out)
	if x.config.Routing.Schedule == nil {
		t.Fatal("saving routes alone must keep the schedule")
	}

	// null removes it, and the per-window lists go with it.
	payload := scheduledRoutes()
	payload["schedule"] = nil
	code, out = request(t, x.h, "PUT", "/routing", payload)
	checkStatus(t, code, 200, out)
	if x.config.Routing.Schedule != nil || x.config.Routing.Routings[0].Windows != nil {
		t.Fatalf("schedule not removed: %+v / %v", x.config.Routing.Schedule, x.config.Routing.Routings[0].Windows)
	}
	if _, ok := out["schedule"]; ok {
		t.Fatal("no schedule means no schedule status")
	}
}
