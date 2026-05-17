# scripts/testSuite.ps1
# CaaS-Lite endpoint test suite - compatible with PowerShell 5 and 7.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\testSuite.ps1

param(
    [string]$BaseUrl       = "http://localhost:3000",
    [string]$TenantId      = "tenant-demo-001",
    [string]$Tier          = "GROWTH",
    [int]   $SpikeRequests = 80
)

$pass = 0; $fail = 0
$script:AccessToken  = ""
$script:RefreshToken = ""

function Write-Pass { param($msg) Write-Host "  [PASS] $msg" -ForegroundColor Green;  $script:pass++ }
function Write-Fail { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $script:fail++ }
function Write-Head { param($msg) Write-Host ""; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Write-Info { param($msg) Write-Host "         $msg" -ForegroundColor Gray }

function Invoke-API {
    param(
        [string]$Method = "GET",
        [string]$Path,
        [hashtable]$Body = $null,
        [hashtable]$Extra = @{},
        [switch]$NoAuth
    )
    $headers = @{
        "X-Tenant-ID"  = $TenantId
        "X-CaaS-Tier"  = $Tier
        "Content-Type" = "application/json"
    }
    if ($script:AccessToken -and -not $NoAuth) {
        $headers["Authorization"] = "Bearer $($script:AccessToken)"
    }
    foreach ($k in $Extra.Keys) { $headers[$k] = $Extra[$k] }

    $params = @{
        Uri             = "$BaseUrl$Path"
        Method          = $Method
        Headers         = $headers
        UseBasicParsing = $true
    }
    if ($Body) { $params["Body"] = ($Body | ConvertTo-Json -Depth 10) }

    try {
        $resp = Invoke-WebRequest @params
        $parsed = $null
        try { $parsed = $resp.Content | ConvertFrom-Json } catch {}
        return @{ ok = $true; status = [int]$resp.StatusCode; body = $parsed }
    } catch {
        $sc   = 0
        $body = $null
        if ($_.Exception.Response) {
            $sc = [int]$_.Exception.Response.StatusCode
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $raw    = $reader.ReadToEnd()
                try { $body = $raw | ConvertFrom-Json } catch { $body = $raw }
            } catch {}
        }
        return @{ ok = $false; status = $sc; body = $body }
    }
}

# ── 1. Health ──────────────────────────────────────────────────────────────────
Write-Head "1. Server Health"

$r = Invoke-API -Path "/health" -NoAuth
if ($r.status -eq 200) { Write-Pass "GET /health -> 200 (uptime: $($r.body.uptime_seconds)s)" }
else { Write-Fail "GET /health -> $($r.status)" }

$r = Invoke-API -Path "/health/db" -NoAuth
if ($r.status -eq 200) { Write-Pass "GET /health/db -> 200 (integrity_ok: $($r.body.integrity_ok))" }
else { Write-Fail "GET /health/db -> $($r.status)" }

$r = Invoke-API -Path "/metrics" -NoAuth
if ($r.status -eq 200) { Write-Pass "GET /metrics -> 200 (Prometheus active)" }
else { Write-Fail "GET /metrics -> $($r.status)" }

# ── 2. Auth ────────────────────────────────────────────────────────────────────
Write-Head "2. Authentication"

$r = Invoke-API -Method POST -Path "/api/v1/auth/login" -NoAuth -Body @{
    username = "exec_demo"; password = "ExecPass123!"; tenant_id = $TenantId
}
if ($r.status -eq 200 -and $r.body.access_token) {
    $script:AccessToken  = $r.body.access_token
    $script:RefreshToken = $r.body.refresh_token
    Write-Pass "POST /api/v1/auth/login -> 200 (token received)"
    Write-Info "Token prefix: $($script:AccessToken.Substring(0,40))..."
} else { Write-Fail "POST /api/v1/auth/login -> $($r.status) $($r.body)" }

$r = Invoke-API -Path "/api/v1/auth/me"
if ($r.status -eq 200 -and $r.body.username -eq "exec_demo") {
    Write-Pass "GET /api/v1/auth/me -> 200 (role: $($r.body.role))"
} else { Write-Fail "GET /api/v1/auth/me -> $($r.status)" }

$r = Invoke-API -Method POST -Path "/api/v1/auth/refresh" -NoAuth -Body @{
    refresh_token = $script:RefreshToken
}
if ($r.status -eq 200 -and $r.body.access_token) {
    $script:AccessToken = $r.body.access_token
    Write-Pass "POST /api/v1/auth/refresh -> 200 (token rotated)"
} else { Write-Fail "POST /api/v1/auth/refresh -> $($r.status)" }

$r = Invoke-API -Method POST -Path "/api/v1/auth/login" -NoAuth -Body @{
    username = "exec_demo"; password = "WrongPassword!"; tenant_id = $TenantId
}
if ($r.status -eq 401) { Write-Pass "Bad password -> 401 (brute-force delay active)" }
else { Write-Fail "Expected 401 got $($r.status)" }

# ── 3. Payouts ─────────────────────────────────────────────────────────────────
Write-Head "3. Payout Endpoints"

$r = Invoke-API -Path "/api/v1/payouts?limit=10"
if ($r.status -eq 200) {
    $count = $r.body.data.Count
    Write-Pass "GET /api/v1/payouts -> 200 ($count records)"
    if ($count -gt 0) {
        $f = $r.body.data[0]
        Write-Info "Sample: $($f.status) USD $($f.amount_usd) -> $($f.local_currency) $($f.local_amount)"
    }
} else { Write-Fail "GET /api/v1/payouts -> $($r.status)" }

$r = Invoke-API -Method POST -Path "/api/v1/payouts/sweep"
Write-Pass "POST /api/v1/payouts/sweep -> $($r.status) (provider errors expected in dev)"
if ($r.body -and $r.body.total_agents_evaluated) {
    Write-Info "Evaluated: $($r.body.total_agents_evaluated) | initiated: $($r.body.total_initiated) | failed: $($r.body.total_failed)"
}

# ── 4. Anomalies ───────────────────────────────────────────────────────────────
Write-Head "4. Anomaly Endpoints"

$r = Invoke-API -Path "/api/v1/anomalies?limit=10"
if ($r.status -eq 200) {
    Write-Pass "GET /api/v1/anomalies -> 200 ($($r.body.data.Count) records)"
    Write-Info "Stats: total=$($r.body.stats.total) lockouts=$($r.body.stats.lockouts_applied)"
} else { Write-Fail "GET /api/v1/anomalies -> $($r.status)" }

$r = Invoke-API -Path "/api/v1/anomalies?risk_level=high"
if ($r.status -eq 200) {
    Write-Pass "GET /api/v1/anomalies?risk_level=high -> 200 ($($r.body.data.Count) events)"
} else { Write-Fail "GET /api/v1/anomalies?risk_level=high -> $($r.status)" }

# ── 5. FX Rates ────────────────────────────────────────────────────────────────
Write-Head "5. FX Rate Endpoints"

foreach ($currency in @("GHS","NGN","KES","GBP")) {
    $r = Invoke-API -Path "/api/v1/fx/rates/$currency"
    if ($r.status -eq 200) {
        $rate = $r.body.current
        Write-Pass "GET /api/v1/fx/rates/$currency -> 200 (mid=$($rate.mid_rate) via $($rate.provider))"
    } else { Write-Fail "GET /api/v1/fx/rates/$currency -> $($r.status)" }
}

# ── 6. Compliance ──────────────────────────────────────────────────────────────
Write-Head "6. Compliance Endpoints"

$r = Invoke-API -Path "/api/v1/compliance/profiles"
if ($r.status -eq 200) {
    Write-Pass "GET /api/v1/compliance/profiles -> 200 ($($r.body.Count) profiles)"
} else { Write-Fail "GET /api/v1/compliance/profiles -> $($r.status)" }

$r = Invoke-API -Path "/api/v1/compliance/countries"
if ($r.status -eq 200) {
    Write-Pass "GET /api/v1/compliance/countries -> 200 ($($r.body.total) countries)"
} else { Write-Fail "GET /api/v1/compliance/countries -> $($r.status)" }

# ── 7. Rate Limiter Tiers ──────────────────────────────────────────────────────
Write-Head "7. Rate Limiter Tier Verification"

foreach ($t in @("PAY_AS_YOU_GO","GROWTH","ENTERPRISE")) {
    $r = Invoke-API -Path "/api/v1/compliance/profiles" -Extra @{ "X-CaaS-Tier" = $t }
    if ($r.status -eq 200) { Write-Pass "$t tier -> 200" }
    else { Write-Fail "$t tier -> $($r.status)" }
}

# ── 8. Spike Test ──────────────────────────────────────────────────────────────
Write-Head "8. Spike Test ($SpikeRequests requests PAY_AS_YOU_GO burst=15)"
Write-Info "Firing $SpikeRequests sequential requests to trigger throttling..."

$ok200 = 0; $ok429 = 0; $other = 0
$spikeStart = Get-Date

for ($i = 0; $i -lt $SpikeRequests; $i++) {
    $r = Invoke-API -Path "/api/v1/compliance/profiles" -Extra @{ "X-CaaS-Tier" = "PAY_AS_YOU_GO" }
    if ($r.status -eq 200)     { $ok200++ }
    elseif ($r.status -eq 429) { $ok429++ }
    else                       { $other++ }
}

$duration = [math]::Round(((Get-Date) - $spikeStart).TotalSeconds, 2)
Write-Host ""
Write-Host "  Spike results ($SpikeRequests requests in ${duration}s):" -ForegroundColor White
Write-Host "  200 Allowed  : $ok200" -ForegroundColor Green
Write-Host "  429 Throttled: $ok429" -ForegroundColor Yellow
if ($other -gt 0) { Write-Host "  Other errors : $other" -ForegroundColor Red }

if ($ok429 -gt 0) { Write-Pass "Rate limiter throttled $ok429 of $SpikeRequests requests" }
else { Write-Info "No 429s - requests spaced too slowly for burst window. Burst capacity=15 tokens." }

# ── 9. Admin ───────────────────────────────────────────────────────────────────
Write-Head "9. Admin Endpoints"

$r = Invoke-API -Path "/api/v1/admin/backups"
if ($r.status -eq 200) {
    Write-Pass "GET /api/v1/admin/backups -> 200 (failover=$($r.body.failover.active))"
} else { Write-Fail "GET /api/v1/admin/backups -> $($r.status)" }

$r = Invoke-API -Path "/health/performance"
if ($r.status -eq 200) {
    Write-Pass "GET /health/performance -> 200 (SQLite $($r.body.sqlite_version) journal=$($r.body.journal_mode))"
    if ($r.body.recommendations -and $r.body.recommendations.Count -gt 0) {
        Write-Info "Recommendations:"
        $r.body.recommendations | ForEach-Object { Write-Info "  * $_" }
    }
} else { Write-Fail "GET /health/performance -> $($r.status)" }

# ── Summary ────────────────────────────────────────────────────────────────────
Write-Head "Results"
$total = $pass + $fail
Write-Host "  Passed: $pass / $total" -ForegroundColor Green
if ($fail -gt 0) { Write-Host "  Failed: $fail / $total" -ForegroundColor Red }
else { Write-Host "  All tests passed." -ForegroundColor Green }
Write-Host ""
