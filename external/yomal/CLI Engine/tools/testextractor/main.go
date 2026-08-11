package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/chanbistec/btg-devops/internal/extractors"
)

func main() {
	subID := os.Getenv("AZURE_SUBSCRIPTION_ID")
	if subID == "" {
		fmt.Fprintln(os.Stderr, "AZURE_SUBSCRIPTION_ID not set")
		os.Exit(1)
	}

	// Optional: pass a resource name as argument to extract one resource only
	// Usage: go run ./tools/testextractor/ storage
	// Usage: go run ./tools/testextractor/ all
	target := "all"
	if len(os.Args) > 1 {
		target = os.Args[1]
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "auth failed: %v\n", err)
		os.Exit(1)
	}

	ctx := context.Background()

	type extractor struct {
		name string
		run  func() (any, error)
	}

	extractorsList := []extractor{
		{"storage", func() (any, error) { return extractors.ExtractStorage(ctx, subID, cred) }},
		{"iam", func() (any, error) { return extractors.ExtractIAM(ctx, subID, cred) }},
		{"nsg", func() (any, error) { return extractors.ExtractNSG(ctx, subID, cred) }},
		{"acr", func() (any, error) { return extractors.ExtractACR(ctx, subID, cred) }},
		{"cosmosdb", func() (any, error) { return extractors.ExtractCosmosDB(ctx, subID, cred) }},
		{"keyvault", func() (any, error) { return extractors.ExtractKeyVault(ctx, subID, cred) }},
		{"functions", func() (any, error) { return extractors.ExtractFunctions(ctx, subID, cred) }},
		{"publicip", func() (any, error) { return extractors.ExtractPublicIP(ctx, subID, cred) }},
		{"appserviceplan", func() (any, error) { return extractors.ExtractAppServicePlan(ctx, subID, cred) }},
		{"cognitiveservices", func() (any, error) { return extractors.ExtractCognitiveServices(ctx, subID, cred) }},
		{"resourcegroup", func() (any, error) { return extractors.ExtractResourceGroup(ctx, subID, cred) }},
		{"appservice", func() (any, error) { return extractors.ExtractAppService(ctx, subID, cred) }},
	}

	// single resource mode
	if target != "all" {
		for _, e := range extractorsList {
			if e.name == target {
				fmt.Fprintf(os.Stderr, "Extracting %s...\n\n", target)
				data, err := e.run()
				if err != nil {
					fmt.Fprintf(os.Stderr, "error: %v\n", err)
					os.Exit(1)
				}
				out, _ := json.MarshalIndent(data, "", "  ")
				fmt.Println(string(out))
				return
			}
		}
		fmt.Fprintf(os.Stderr, "unknown resource: %q\n\nAvailable resources:\n", target)
		for _, e := range extractorsList {
			fmt.Fprintf(os.Stderr, "  %s\n", e.name)
		}
		os.Exit(1)
	}

	// all resources mode
	result := map[string]any{}
	for i, e := range extractorsList {
		fmt.Fprintf(os.Stderr, "[%d/%d] %s...\n", i+1, len(extractorsList), e.name)
		data, err := e.run()
		if err != nil {
			fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
			continue
		}
		result[e.name] = data
	}

	fmt.Fprintln(os.Stderr, "\nDone. Clean JSON output:")
	out, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(out))
}
