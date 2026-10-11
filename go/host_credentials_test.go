package copilot

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/github/copilot-sdk/go/internal/jsonrpc2"
	"github.com/github/copilot-sdk/go/rpc"
)

func TestAhpHostCredentialProvidersAreIsolatedAndReleased(t *testing.T) {
	client, server, _ := ahpFixture(t)
	var registrations []string
	server.SetRequestHandler("host.start", jsonrpc2.RequestHandlerFor(func(params *rpc.HostStartRequest) (*rpc.HostStartResult, *jsonrpc2.Error) {
		registrations = append(registrations, *params.GitHubEnvironment.CredentialProviderRegistrationID)
		if params.GitHubEnvironment.ComputeID != "agent:4e7d462e-6072-4bc0-bf06-d9faf363a214" {
			t.Error("compute identity changed")
		}
		return &rpc.HostStartResult{HostID: params.HostID}, nil
	}))
	var hosts []*AhpHost
	for index := range 2 {
		rotations := 0
		options := &AhpHostOptions{
			GitHubEnvironment: &rpc.HostGitHubEnvironmentOptions{
				Name: "managed host", ComputeID: "agent:4e7d462e-6072-4bc0-bf06-d9faf363a214",
			},
			GitHubTokenProvider: func(args GitHubTokenProviderArgs) (*GitHubTokenProviderResult, error) {
				if args.SessionID != nil || args.Host != "github.example.com" {
					t.Errorf("unexpected host callback arguments: %+v", args)
				}
				rotations++
				return GitHubTokenResult(&GitHubToken{AccessToken: fmt.Sprintf("host-%d-token-%d", index, rotations), ExpiresIn: 3600}), nil
			},
		}
		host, err := client.StartAhpHost(t.Context(), options)
		if err != nil {
			t.Fatal(err)
		}
		if options.GitHubEnvironment.CredentialProviderRegistrationID != nil {
			t.Fatal("StartAhpHost mutated caller options")
		}
		hosts = append(hosts, host)
	}
	if registrations[0] == registrations[1] {
		t.Fatal("hosts share credential registrations")
	}
	for rotation := 1; rotation <= 2; rotation++ {
		for index, registration := range registrations {
			raw, err := server.Request(t.Context(), "gitHubToken.getToken", &rpc.GitHubTokenAcquireRequest{
				RegistrationID: registration, Host: "github.example.com", Reason: rpc.GitHubTokenAcquireReasonRefresh,
			})
			if err != nil {
				t.Fatal(err)
			}
			var token rpc.GitHubTokenAcquireResultToken
			if err := json.Unmarshal(raw, &token); err != nil {
				t.Fatal(err)
			}
			if token.AccessToken != fmt.Sprintf("host-%d-token-%d", index, rotation) {
				t.Fatal("wrong host's credential returned")
			}
		}
	}
	client.handleAhpExit(&rpc.HostExitedNotification{HostID: hosts[0].HostID, Reason: "disposed"})
	adapter := &gitHubTokenAdapter{client: client}
	if _, err := adapter.GetToken(&rpc.GitHubTokenAcquireRequest{RegistrationID: registrations[0]}); err == nil {
		t.Fatal("exited host retained provider")
	}
	if _, err := adapter.GetToken(&rpc.GitHubTokenAcquireRequest{RegistrationID: registrations[1], Host: "github.example.com"}); err != nil {
		t.Fatalf("one host's exit removed another provider: %v", err)
	}
	client.disconnectAhpHosts()
	if len(client.gitHubTokenProviders) != 0 {
		t.Fatal("disconnect retained hosting providers")
	}
}

func TestAhpHostCredentialProviderFailureAndStartupRollback(t *testing.T) {
	client, server, _ := ahpFixture(t)
	sentinel := errors.New("credential acquisition failed")
	var registration string
	server.SetRequestHandler("host.start", jsonrpc2.RequestHandlerFor(func(params *rpc.HostStartRequest) (*rpc.HostStartResult, *jsonrpc2.Error) {
		registration = *params.GitHubEnvironment.CredentialProviderRegistrationID
		adapter := &gitHubTokenAdapter{client: client}
		if _, err := adapter.GetToken(&rpc.GitHubTokenAcquireRequest{RegistrationID: registration}); !errors.Is(err, sentinel) {
			t.Errorf("provider error not preserved: %v", err)
		}
		return nil, &jsonrpc2.Error{Code: -32000, Message: "hosting preflight failed"}
	}))
	_, err := client.StartAhpHost(t.Context(), &AhpHostOptions{
		GitHubEnvironment: &rpc.HostGitHubEnvironmentOptions{Name: "managed", ComputeID: "compute"},
		GitHubTokenProvider: func(GitHubTokenProviderArgs) (*GitHubTokenProviderResult, error) {
			return nil, sentinel
		},
	})
	if err == nil || registration == "" || len(client.gitHubTokenProviders) != 0 {
		t.Fatalf("startup rollback: error=%v, providers=%d", err, len(client.gitHubTokenProviders))
	}
}

func TestAhpHostCredentialProviderRequiresUnambiguousEnvironment(t *testing.T) {
	provider := func(GitHubTokenProviderArgs) (*GitHubTokenProviderResult, error) { return GitHubTokenCancelled(), nil }
	for _, options := range []*AhpHostOptions{
		{LocalServer: &rpc.HostLocalServerOptions{}, GitHubTokenProvider: provider},
		{GitHubEnvironment: &rpc.HostGitHubEnvironmentOptions{CredentialProviderRegistrationID: String("other")}, GitHubTokenProvider: provider},
	} {
		if _, err := NewClient(nil).StartAhpHost(t.Context(), options); err == nil {
			t.Fatal("invalid provider configuration accepted")
		}
	}
}
