package crypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)

// DecryptSecret decrypts a stored secret using the active provider.
// Switch providers via SECRET_PROVIDER env var:
//
//	aes256   — local AES-256-GCM (development, default)
//	keyvault — Azure Key Vault (production)
func DecryptSecret(stored string) (string, error) {
	provider := os.Getenv("SECRET_PROVIDER")
	if provider == "keyvault" {
		return kvDecrypt(stored)
	}
	return aesDecrypt(stored)
}

// ─── AES-256-GCM (Option 1) ──────────────────────────────────────────────────

func aesDecrypt(stored string) (string, error) {
	keyB64 := os.Getenv("ENCRYPTION_KEY")
	if keyB64 == "" {
		return "", fmt.Errorf("ENCRYPTION_KEY env var not set")
	}

	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return "", fmt.Errorf("decoding ENCRYPTION_KEY: %w", err)
	}
	if len(key) != 32 {
		return "", fmt.Errorf("ENCRYPTION_KEY must be 32 bytes, got %d", len(key))
	}

	parts := strings.Split(stored, ":")
	if len(parts) != 3 {
		return "", fmt.Errorf("invalid AES encrypted format, expected iv:authTag:ciphertext")
	}

	iv, err := hex.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("decoding iv: %w", err)
	}
	authTag, err := hex.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("decoding authTag: %w", err)
	}
	enc, err := hex.DecodeString(parts[2])
	if err != nil {
		return "", fmt.Errorf("decoding ciphertext: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	// Go's GCM Open expects ciphertext with authTag appended
	combined := append(enc, authTag...)
	plaintext, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return "", fmt.Errorf("decrypting secret: %w", err)
	}
	return string(plaintext), nil
}

// ─── Azure Key Vault (Option 2) ──────────────────────────────────────────────

func kvDecrypt(secretName string) (string, error) {
	vaultURL := os.Getenv("KEYVAULT_URL")
	if vaultURL == "" {
		return "", fmt.Errorf("KEYVAULT_URL env var not set")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return "", fmt.Errorf("keyvault auth: %w", err)
	}

	client, err := azsecrets.NewClient(vaultURL, cred, nil)
	if err != nil {
		return "", fmt.Errorf("creating keyvault client: %w", err)
	}

	resp, err := client.GetSecret(context.Background(), secretName, "", nil)
	if err != nil {
		return "", fmt.Errorf("fetching secret '%s' from keyvault: %w", secretName, err)
	}
	if resp.Value == nil {
		return "", fmt.Errorf("keyvault secret '%s' has no value", secretName)
	}
	return *resp.Value, nil
}
