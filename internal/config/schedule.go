package config

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // zone data for hosts that have no system copy, such as Windows
)

var clockRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):([0-5][0-9])$`)

// maxScheduleWindows keeps the editor and the per-routing tables readable.
const maxScheduleWindows = 12

// ParseClock reads "HH:MM" as minutes since midnight.
func ParseClock(value string) (int, bool) {
	m := clockRe.FindStringSubmatch(value)
	if m == nil {
		return 0, false
	}
	hours, _ := strconv.Atoi(m[1])
	minutes, _ := strconv.Atoi(m[2])
	return hours*60 + minutes, true
}

// parseSchedule reads routing.schedule. Nothing, null, or an object with no zone
// and no windows all mean "no schedule".
func parseSchedule(raw any) (*ScheduleConfig, error) {
	if raw == nil {
		return nil, nil
	}
	value, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("routing.schedule must be an object")
	}
	timezone := textField(value["timezone"])
	if timezone != "" {
		if _, err := time.LoadLocation(timezone); err != nil {
			return nil, fmt.Errorf("routing.schedule.timezone %q is not a known time zone (use a name such as Asia/Singapore)", timezone)
		}
	}
	items, _ := value["windows"].([]any)
	if len(items) > maxScheduleWindows {
		return nil, fmt.Errorf("routing.schedule.windows: at most %d windows", maxScheduleWindows)
	}
	windows := make([]ScheduleWindow, 0, len(items))
	seen := map[string]bool{}
	for i, item := range items {
		record := asRecord(item)
		id, _ := record["id"].(string)
		if !isRoutingID(id) {
			return nil, fmt.Errorf(`routing.schedule.windows[%d].id must be a slug (lowercase letters, digits, hyphens; not "auto")`, i)
		}
		if seen[id] {
			return nil, fmt.Errorf(`routing.schedule.windows: duplicate id "%s"`, id)
		}
		seen[id] = true
		start, end := textField(record["start"]), textField(record["end"])
		from, startOK := ParseClock(start)
		to, endOK := ParseClock(end)
		if !startOK || !endOK {
			return nil, fmt.Errorf("routing.schedule.windows[%d]: start and end must be times such as 08:00 or 22:30", i)
		}
		if from == to {
			return nil, fmt.Errorf("routing.schedule.windows[%d]: start and end must differ", i)
		}
		label := textField(record["label"])
		if label == "" {
			label = id
		}
		windows = append(windows, ScheduleWindow{ID: id, Label: label, Start: start, End: end})
	}
	if timezone == "" && len(windows) == 0 {
		return nil, nil
	}
	return &ScheduleConfig{Timezone: timezone, Windows: windows}, nil
}

// parseRoutingWindows reads a routing's per-window model lists. Empty lists mean
// "use the routing's own models", so they are dropped.
func parseRoutingWindows(raw any) map[string][]string {
	if raw == nil {
		return nil
	}
	out := map[string][]string{}
	for id, list := range asRecord(raw) {
		if !isRoutingID(id) {
			continue
		}
		models := []string{}
		seen := map[string]bool{}
		for _, model := range stringArray(list) {
			model = strings.TrimSpace(model)
			if model != "" && !seen[model] {
				seen[model] = true
				models = append(models, model)
			}
		}
		if len(models) > 0 {
			out[id] = models
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// routingModels is every model a routing can run: its own list, then the list of each
// window in a stable order. Provider order applies to all of them.
func routingModels(models []string, windows map[string][]string) []string {
	out := append([]string(nil), models...)
	ids := make([]string, 0, len(windows))
	for id := range windows {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		out = append(out, windows[id]...)
	}
	return out
}

// pruneWindows drops per-window model lists whose window no longer exists, so
// deleting a window never leaves orphaned lists behind. Provider order for a model
// that only those lists used goes with them.
func pruneWindows(routings []RoutingEntry, schedule *ScheduleConfig) {
	known := map[string]bool{}
	if schedule != nil {
		for _, window := range schedule.Windows {
			known[window.ID] = true
		}
	}
	for i := range routings {
		for id := range routings[i].Windows {
			if !known[id] {
				delete(routings[i].Windows, id)
			}
		}
		if len(routings[i].Windows) == 0 {
			routings[i].Windows = nil
		}
		if routings[i].Providers != nil {
			routings[i].Providers = pruneProviderOrder(
				routingModels(routings[i].Models, routings[i].Windows), routings[i].Providers)
		}
	}
}
