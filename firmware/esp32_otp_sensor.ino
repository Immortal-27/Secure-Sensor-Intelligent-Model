/*
 * esp32_otp_sensor.ino
 * ---------------------------------------------------------------------------
 * Quantum-Resilient IoT Telemetry — ESP32 Firmware
 *
 * Reads 8 analog sensor channels (or generates synthetic readings if no
 * sensors are wired), generates 8 fresh TRNG entropy bytes per frame via
 * esp_random(), and outputs JSON lines over Serial at 115200 baud.
 *
 * Output format (one JSON object per line):
 *   {"v":[23.4,65.1,1013.2,540,412,0.8,3.3,1.2],"pad":[198,44,71,200,5,130,99,55],"pid":42}
 *
 * LED heartbeat on GPIO2 (built-in LED on most ESP32 dev boards).
 *
 * DISCLAIMER: This firmware is part of an educational OTP demonstration.
 * The pad bytes are transmitted alongside sensor data for demo purposes.
 * In a real deployment, pad material would be pre-shared or exchanged
 * via a secure key establishment protocol.
 * ---------------------------------------------------------------------------
 */

#include <Arduino.h>

/* ═══════════════════════════════════════════════════════════════════════ */
/* CONFIGURATION                                                         */
/* ═══════════════════════════════════════════════════════════════════════ */

#define NUM_CHANNELS       8
#define SERIAL_BAUD        115200
#define FRAME_INTERVAL_MS  1000
#define LED_PIN            2          /* Built-in LED on most ESP32 boards */
#define MODULUS            257        /* Prime modulus for OTP arithmetic  */

/* Analog input pins — adjust for your wiring.                            */
/* If pins are floating (no sensors), synthetic data is generated instead. */
static const int ANALOG_PINS[NUM_CHANNELS] = {
    36, 39, 34, 35, 32, 33, 25, 26
};

/* Sensor scaling: each ADC reading (0-4095) is mapped to a physical range */
static const float SCALE_MIN[NUM_CHANNELS] = {
    0.0,    0.0,    950.0,  0.0,    0.0,    0.0, 0.0, 0.0
};
static const float SCALE_MAX[NUM_CHANNELS] = {
    100.0,  100.0,  1050.0, 10000.0, 5000.0, 5.0, 5.0, 5.0
};

/* Synthetic data: center values and drift amplitude for no-hardware mode */
static const float SYNTH_CENTER[NUM_CHANNELS] = {
    25.0, 50.0, 1013.0, 400.0, 450.0, 0.3, 3.3, 0.8
};
static const float SYNTH_AMP[NUM_CHANNELS] = {
    10.0, 15.0, 15.0, 200.0, 150.0, 0.5, 0.5, 0.4
};

/* ═══════════════════════════════════════════════════════════════════════ */
/* GLOBALS                                                                */
/* ═══════════════════════════════════════════════════════════════════════ */

static uint32_t packet_id = 0;
static bool     use_synthetic = false;
static bool     led_state = false;

/* ═══════════════════════════════════════════════════════════════════════ */
/* HARDWARE DETECTION                                                     */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * Check whether real analog sensors are connected by reading all channels
 * and seeing if any produce non-zero, non-max values. If all channels
 * read 0 or 4095, assume no sensors and switch to synthetic mode.
 */
static bool detect_sensors(void) {
    int zero_or_max_count = 0;
    for (int i = 0; i < NUM_CHANNELS; i++) {
        int raw = analogRead(ANALOG_PINS[i]);
        if (raw <= 10 || raw >= 4085) {
            zero_or_max_count++;
        }
    }
    /* If 6+ out of 8 channels are at rail, assume no hardware sensors */
    return (zero_or_max_count < 6);
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* SENSOR READING                                                         */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * Read one channel from the ADC and scale to physical units.
 */
static float read_adc_channel(int ch) {
    int raw = analogRead(ANALOG_PINS[ch]);
    float fraction = (float)raw / 4095.0f;
    return SCALE_MIN[ch] + fraction * (SCALE_MAX[ch] - SCALE_MIN[ch]);
}

/**
 * Generate a synthetic reading for one channel using sinusoidal drift.
 */
static float generate_synthetic(int ch, float elapsed_sec) {
    float freq = 0.08f + ch * 0.015f;
    float phase = ch * 0.7f;
    float drift = SYNTH_AMP[ch] * sinf(2.0f * PI * freq * elapsed_sec + phase);
    /* Add small pseudo-random jitter */
    float jitter = ((float)(esp_random() % 1000) / 1000.0f - 0.5f) * SYNTH_AMP[ch] * 0.2f;
    return SYNTH_CENTER[ch] + drift + jitter;
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* TRNG ENTROPY                                                           */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * Generate one entropy byte in [0, MODULUS-1] from the ESP32 hardware TRNG.
 *
 * esp_random() returns a 32-bit value derived from thermal noise and
 * RF jitter in the ESP32 hardware. We take the lower 16 bits and
 * reduce modulo MODULUS to get a value in [0, 256].
 */
static uint16_t generate_entropy_byte(void) {
    uint32_t r = esp_random();
    return (uint16_t)(r % MODULUS);
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* JSON OUTPUT                                                            */
/* ═══════════════════════════════════════════════════════════════════════ */

/**
 * Emit one telemetry frame as a JSON line over Serial.
 *
 * Format:
 *   {"v":[f0,f1,...,f7],"pad":[k0,k1,...,k7],"pid":N}
 */
static void emit_frame(const float values[], const uint16_t pad[], uint32_t pid) {
    Serial.print("{\"v\":[");
    for (int i = 0; i < NUM_CHANNELS; i++) {
        if (i > 0) Serial.print(",");
        Serial.print(values[i], 2);
    }
    Serial.print("],\"pad\":[");
    for (int i = 0; i < NUM_CHANNELS; i++) {
        if (i > 0) Serial.print(",");
        Serial.print(pad[i]);
    }
    Serial.print("],\"pid\":");
    Serial.print(pid);
    Serial.println("}");
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* SETUP & LOOP                                                           */
/* ═══════════════════════════════════════════════════════════════════════ */

void setup() {
    Serial.begin(SERIAL_BAUD);
    while (!Serial) { delay(10); }

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    /* Configure ADC */
    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);

    /* Detect whether real sensors are connected */
    bool sensors_found = detect_sensors();
    use_synthetic = !sensors_found;

    Serial.println("# ──────────────────────────────────────────────────");
    Serial.println("# Quantum-Resilient IoT Telemetry — ESP32 TRNG");
    Serial.print("# Mode: ");
    Serial.println(use_synthetic ? "SYNTHETIC (no sensors detected)" : "HARDWARE ADC");
    Serial.print("# Channels: ");
    Serial.println(NUM_CHANNELS);
    Serial.print("# Modulus N: ");
    Serial.println(MODULUS);
    Serial.print("# Entropy source: esp_random() (hardware TRNG)");
    Serial.println();
    Serial.println("# ──────────────────────────────────────────────────");

    delay(500);
}

void loop() {
    static unsigned long last_frame_ms = 0;
    unsigned long now = millis();

    if (now - last_frame_ms < FRAME_INTERVAL_MS) {
        return;
    }
    last_frame_ms = now;

    /* Toggle LED heartbeat */
    led_state = !led_state;
    digitalWrite(LED_PIN, led_state ? HIGH : LOW);

    /* Collect sensor values */
    float values[NUM_CHANNELS];
    float elapsed_sec = (float)now / 1000.0f;

    for (int i = 0; i < NUM_CHANNELS; i++) {
        if (use_synthetic) {
            values[i] = generate_synthetic(i, elapsed_sec);
        } else {
            values[i] = read_adc_channel(i);
        }
    }

    /* Generate TRNG entropy pad */
    uint16_t pad[NUM_CHANNELS];
    for (int i = 0; i < NUM_CHANNELS; i++) {
        pad[i] = generate_entropy_byte();
    }

    /* Emit JSON frame */
    packet_id++;
    emit_frame(values, pad, packet_id);
}
