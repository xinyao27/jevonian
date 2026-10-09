package config

import (
	"encoding/json"
	"strings"
	"testing"
)

// scheduleInput is a minimal config value with a routing schedule.
func scheduleInput(schedule any, windows map[string]any) map[string]any {
	plan := map[string]any{"id": "plan", "label": "Plan", "models": []any{"day-max"}}
	if windows != nil {
		plan["windows"] = windows
	}
	routing := map[string]any{"routings": []any{plan}}
	if schedule != nil {
		routing["schedule"] = schedule
	}
	return map[string]any{"routing": routing}
}

func TestParseScheduleKeepsZoneWindowsAndRoutingLists(t *testing.T) {
	cfg, err := ParseConfig(scheduleInput(
		map[string]any{
			"timezone": "Asia/Singapore",
			"windows": []any{
				map[string]any{"id": "night", "label": "Off-nights", "start": "22:00", "end": "08:00"},
			},
		},
		map[string]any{"night": []any{"night-max", "night-max", " ", "night-flash"}},
	))
	if err != nil {
		t.Fatal(err)
	}
	s := cfg.Routing.Schedule
	if s == nil || s.Timezone != "Asia/Singapore" || len(s.Windows) != 1 {
		t.Fatalf("schedule = %+v", s)
	}
	if w := s.Windows[0]; w.ID != "night" || w.Label != "Off-nights" || w.Start != "22:00" || w.End != "08:00" {
		t.Fatalf("window = %+v", w)
	}
	var plan RoutingEntry
	for _, r := range cfg.Routing.Routings {
		if r.ID == "plan" {
			plan = r
		}
	}
	if got := strings.Join(plan.Windows["night"], ","); got != "night-max,night-flash" {
		t.Fatalf("window models = %q (duplicates and blanks must be dropped)", got)
	}
	if got := strings.Join(plan.Models, ","); got != "day-max" {
		t.Fatalf("base models changed: %q", got)
	}
}

func TestParseScheduleRoundTripsThroughJSONValue(t *testing.T) {
	first, err := ParseConfig(scheduleInput(
		map[string]any{"timezone": "UTC", "windows": []any{map[string]any{"id": "late", "start": "23:30", "end": "01:00"}}},
		map[string]any{"late": []any{"m1"}},
	))
	if err != nil {
		t.Fatal(err)
	}
	value, err := JSONValue(&first)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ParseConfig(value)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(first.Routing)
	b, _ := json.Marshal(second.Routing)
	if string(a) != string(b) {
		t.Fatalf("round trip changed routing:\n%s\n%s", a, b)
	}
	if second.Routing.Schedule.Windows[0].Label != "late" {
		t.Fatalf("a missing label must default to the id, got %q", second.Routing.Schedule.Windows[0].Label)
	}
}

func TestParseScheduleAbsentIsOmittedFromDisk(t *testing.T) {
	cfg, err := ParseConfig(scheduleInput(nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Routing.Schedule != nil {
		t.Fatalf("schedule = %+v, want nil", cfg.Routing.Schedule)
	}
	value, _ := JSONValue(&cfg)
	if _, present := value["routing"].(map[string]any)["schedule"]; present {
		t.Fatal("an unset schedule must not be written to the config file")
	}
	empty, err := ParseConfig(scheduleInput(map[string]any{}, nil))
	if err != nil || empty.Routing.Schedule != nil {
		t.Fatalf("an empty schedule object must mean no schedule, got %+v err=%v", empty.Routing.Schedule, err)
	}
}

func TestParseScheduleRejectsBadInput(t *testing.T) {
	window := func(id, start, end string) map[string]any {
		return map[string]any{"id": id, "label": id, "start": start, "end": end}
	}
	tooMany := make([]any, 0, maxScheduleWindows+1)
	for i := 0; i <= maxScheduleWindows; i++ {
		tooMany = append(tooMany, window("w"+string(rune('a'+i)), "01:00", "02:00"))
	}
	cases := map[string]struct {
		schedule any
		want     string
	}{
		"unknown zone":  {map[string]any{"timezone": "Mars/Olympus"}, "not a known time zone"},
		"not an object": {"night", "must be an object"},
		"bad start":     {map[string]any{"windows": []any{window("night", "25:00", "08:00")}}, "start and end must be times"},
		"missing end":   {map[string]any{"windows": []any{window("night", "22:00", "")}}, "start and end must be times"},
		"empty window":  {map[string]any{"windows": []any{window("night", "08:00", "08:00")}}, "must differ"},
		"bad id":        {map[string]any{"windows": []any{window("Night!", "22:00", "08:00")}}, "slug"},
		"duplicate id":  {map[string]any{"windows": []any{window("n", "22:00", "08:00"), window("n", "09:00", "10:00")}}, "duplicate"},
		"too many":      {map[string]any{"windows": tooMany}, "at most"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseConfig(scheduleInput(tc.schedule, nil))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestParseSchedulePrunesListsForRemovedWindows(t *testing.T) {
	cfg, err := ParseConfig(scheduleInput(
		map[string]any{"windows": []any{map[string]any{"id": "night", "start": "22:00", "end": "08:00"}}},
		map[string]any{"night": []any{"a"}, "gone": []any{"b"}},
	))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range cfg.Routing.Routings {
		if r.ID != "plan" {
			continue
		}
		if _, ok := r.Windows["gone"]; ok {
			t.Fatal("a list for a window that is not in the schedule must be dropped")
		}
		if len(r.Windows["night"]) != 1 {
			t.Fatalf("windows = %v", r.Windows)
		}
	}
	noSchedule, err := ParseConfig(scheduleInput(nil, map[string]any{"night": []any{"a"}}))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range noSchedule.Routing.Routings {
		if r.Windows != nil {
			t.Fatalf("%s keeps window lists with no schedule: %v", r.ID, r.Windows)
		}
	}
}

// routingWithProviders is a "plan" routing with its own model, one model only a window lists,
// and a provider order for both.
func routingWithProviders(windowIDs ...string) map[string]any {
	windows := []any{}
	for _, id := range windowIDs {
		windows = append(windows, map[string]any{"id": id, "start": "22:00", "end": "08:00"})
	}
	return map[string]any{"routing": map[string]any{
		"schedule": map[string]any{"windows": windows},
		"routings": []any{map[string]any{
			"id": "plan", "label": "Plan",
			"models":    []any{"day-max"},
			"windows":   map[string]any{"night": []any{"night-max"}},
			"providers": map[string]any{"day-max": []any{"a"}, "night-max": []any{"b", "a"}, "unused": []any{"c"}},
		}},
	}}
}

func planOf(t *testing.T, cfg Config) RoutingEntry {
	t.Helper()
	for _, r := range cfg.Routing.Routings {
		if r.ID == "plan" {
			return r
		}
	}
	t.Fatal("no plan routing")
	return RoutingEntry{}
}

func TestProviderOrderCoversModelsThatOnlyAWindowLists(t *testing.T) {
	cfg, err := ParseConfig(routingWithProviders("night"))
	if err != nil {
		t.Fatal(err)
	}
	plan := planOf(t, cfg)
	if got := strings.Join(plan.Providers["night-max"], ","); got != "b,a" {
		t.Fatalf("provider order for the window-only model = %q, want b,a", got)
	}
	if got := strings.Join(plan.Providers["day-max"], ","); got != "a" {
		t.Fatalf("provider order for the base model = %q, want a", got)
	}
	if _, ok := plan.Providers["unused"]; ok {
		t.Fatal("provider order for a model no list uses must still be dropped")
	}
}

func TestProviderOrderOfARemovedWindowIsDropped(t *testing.T) {
	// The schedule only has a "day" window, so the "night" list and the order for its model go away.
	cfg, err := ParseConfig(routingWithProviders("day"))
	if err != nil {
		t.Fatal(err)
	}
	plan := planOf(t, cfg)
	if plan.Windows != nil {
		t.Fatalf("windows = %v", plan.Windows)
	}
	if _, ok := plan.Providers["night-max"]; ok {
		t.Fatal("provider order for a model only a removed window listed must be dropped")
	}
	if got := strings.Join(plan.Providers["day-max"], ","); got != "a" {
		t.Fatalf("provider order for the base model = %q, want a", got)
	}
}

func TestParseClock(t *testing.T) {
	for in, want := range map[string]int{"00:00": 0, "08:05": 485, "23:59": 1439} {
		if got, ok := ParseClock(in); !ok || got != want {
			t.Errorf("ParseClock(%q) = %d, %v; want %d", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "8:00", "24:00", "12:60", "12:00:00", "noon"} {
		if _, ok := ParseClock(in); ok {
			t.Errorf("ParseClock(%q) must fail", in)
		}
	}
}
