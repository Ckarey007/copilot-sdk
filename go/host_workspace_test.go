package copilot

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/github/copilot-sdk/go/rpc"
)

func workspaceTestClient(t *testing.T, provider *AhpWorkspaceProvider) *Client {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &Client{ahp: ahpHostState{
		hosts: map[string]AhpHostOptions{"host": {
			WorkspaceProvider: provider, workspaceContext: ctx,
			workspaceCancel: cancel, workspaceSlots: make(chan struct{}, 8),
		}},
		handoffs: make(map[string]*ahpHandoff),
	}}
}

func workspaceTestRequest(t *testing.T, host, operation, payload string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(rpc.HostWorkspaceExecuteRequest{
		HostID: host, RequestID: "original-request",
		Operation: rpc.HostWorkspaceOperation(operation), Payload: payload,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func workspaceTestExecute(t *testing.T, client *Client, host, operation, payload string) *rpc.HostWorkspaceExecuteResult {
	t.Helper()
	raw, rpcErr := client.handleHostWorkspaceExecute(context.Background(), workspaceTestRequest(t, host, operation, payload))
	if rpcErr != nil {
		t.Fatal(rpcErr)
	}
	var result rpc.HostWorkspaceExecuteResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return &result
}

func TestAhpWorkspaceDescriptionExistsBeforeSessions(t *testing.T) {
	client := workspaceTestClient(t, &AhpWorkspaceProvider{
		Describe: func(ctx context.Context, call AhpWorkspaceCall) (*AhpWorkspaceDescription, error) {
			if call.HostID != "host" || call.RequestID != "original-request" {
				t.Fatalf("wrong callback ownership: %+v", call)
			}
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 25*time.Second {
				t.Fatal("workspace callback has no bounded deadline")
			}
			return &AhpWorkspaceDescription{Roots: []string{"file:///hands/repo"}}, nil
		},
	})
	result := workspaceTestExecute(t, client, "host", "describe", "{}")
	if result.Error != nil || result.Payload != `{"roots":["file:///hands/repo"]}` {
		t.Fatalf("unexpected description: %+v", result)
	}
}

func TestAhpWorkspaceWritePreservesGuardAndExactOffsets(t *testing.T) {
	called := false
	client := workspaceTestClient(t, &AhpWorkspaceProvider{
		Write: func(_ context.Context, request AhpWorkspaceResourceRequest[AhpWorkspaceWriteParams]) error {
			called = true
			if request.HostID != "host" || request.RequestID != "original-request" {
				t.Fatalf("lost callback identity: %+v", request.AhpWorkspaceCall)
			}
			if request.Params.Position == nil || *request.Params.Position != 9007199254740993 {
				t.Fatalf("offset was rounded: %+v", request.Params.Position)
			}
			if request.Params.IfMatch == nil || *request.Params.IfMatch != "opaque-etag" ||
				request.Params.CreateOnly == nil || *request.Params.CreateOnly ||
				request.Params.Mode == nil || *request.Params.Mode != AhpWorkspaceInsert {
				t.Fatalf("lost write preconditions: %+v", request.Params)
			}
			if request.Params.Channel != "ahp-session:/canonical" || string(request.Params.Meta) != `{"trace":"original"}` ||
				len(request.Guard.Paths) != 1 || request.Guard.Paths[0].CanonicalURI != "file:///hands/repo/file" {
				t.Fatalf("lost AHP metadata or guard: %+v", request)
			}
			return nil
		},
	})
	result := workspaceTestExecute(t, client, "host", "write", `{
		"params":{"channel":"ahp-session:/canonical","_meta":{"trace":"original"},
			"uri":"file:///hands/repo/file","data":"text","encoding":"utf-8",
			"mode":"insert","position":9007199254740993,"ifMatch":"opaque-etag","createOnly":false},
		"guard":{"roots":["file:///hands/repo"],"excluded":[],
			"paths":[{"requestedUri":"file:///hands/repo/file","canonicalUri":"file:///hands/repo/file","mode":"create"}]}}`)
	if !called || result.Error != nil || result.Payload != "{}" {
		t.Fatalf("unexpected write result: %+v", result)
	}
}

func TestAhpWorkspaceFailuresDoNotExposeProviderDiagnostics(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code string
	}{
		{"opaque", errors.New("private credential and filesystem diagnostic"), "internal"},
		{"conflict", &AhpWorkspaceError{Code: "conflict"}, "conflict"},
		{"invalid code", &AhpWorkspaceError{Code: "unknown"}, "internal"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := workspaceTestClient(t, &AhpWorkspaceProvider{
				Read: func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceReadParams]) (*AhpWorkspaceReadResult, error) {
					return nil, test.err
				},
			})
			result := workspaceTestExecute(t, client, "host", "read", `{"params":{"uri":"file:///hands/repo/file"},"guard":{}}`)
			if result.Error == nil || string(*result.Error) != test.code || result.Payload != "{}" {
				t.Fatalf("unexpected error result: %+v", result)
			}
		})
	}
}

func TestAhpWorkspaceMissingProviderAndUnknownHostFailClosed(t *testing.T) {
	client := workspaceTestClient(t, &AhpWorkspaceProvider{})
	for _, test := range []struct{ host, code string }{
		{"host", "notImplemented"}, {"other-host", "permissionDenied"},
	} {
		result := workspaceTestExecute(t, client, test.host, "read", "{}")
		if result.Error == nil || string(*result.Error) != test.code {
			t.Fatalf("unexpected scope result: %+v", result)
		}
	}
}

func TestAhpWorkspaceHostReleaseCancelsAnInflightProvider(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	client := workspaceTestClient(t, &AhpWorkspaceProvider{
		Read: func(ctx context.Context, _ AhpWorkspaceResourceRequest[AhpWorkspaceReadParams]) (*AhpWorkspaceReadResult, error) {
			close(started)
			<-ctx.Done()
			close(stopped)
			return nil, ctx.Err()
		},
	})
	done := make(chan struct{})
	request := workspaceTestRequest(t, "host", "read", "{}")
	go func() {
		defer close(done)
		_, _ = client.handleHostWorkspaceExecute(context.Background(), request)
	}()
	<-started
	client.releaseAhpHost("host")
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("host release did not cancel workspace IO")
	}
	<-done
}
