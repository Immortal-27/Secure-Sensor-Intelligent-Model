#include "DHT.h"

// --- Pin Definitions ---
// Analog Pins for MQ Sensors (ADC1 Pins)
const int mq3Pin   = 32;
const int mq135Pin = 33;
const int mq9Pin   = 34;
const int mq5Pin   = 35;

// Digital Pins for HC-SR04
const int trigPin = 5;
const int echoPin = 18;

// Digital Pin for DHT22
#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

void setup() {
  // ESP32 er jonnyo baud rate 115200 standard
  Serial.begin(115200);
  
  // HC-SR04 Pin Modes
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  
  // Initialize DHT Sensor
  dht.begin();
  
  Serial.println("Initializing Sensors... Please wait.");
  delay(2000); // MQ sensor gulo heat up howar jonnyo ektu somoy lagte pare
}

void loop() {
  Serial.println("=================================");
  
  // 1. Read MQ Sensors
  int mq3Value   = analogRead(mq3Pin);
  int mq135Value = analogRead(mq135Pin);
  int mq9Value   = analogRead(mq9Pin);
  int mq5Value   = analogRead(mq5Pin);
  
  Serial.print("MQ3 (Alcohol): "); Serial.println(mq3Value);
  Serial.print("MQ135 (Air Qlt): "); Serial.println(mq135Value);
  Serial.print("MQ9 (CO/Gas): "); Serial.println(mq9Value);
  Serial.print("MQ5 (LPG): "); Serial.println(mq5Value);

  // 2. Read HC-SR04 (Ultrasonic)
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  
  long duration = pulseIn(echoPin, HIGH);
  float distance = duration * 0.034 / 2;
  
  Serial.print("Distance: "); 
  Serial.print(distance); 
  Serial.println(" cm");

  // 3. Read DHT22 (Temperature & Humidity)
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  
  // Check if DHT read failed
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("Failed to read from DHT sensor!");
  } else {
    Serial.print("Humidity: "); 
    Serial.print(humidity); 
    Serial.print("%  |  Temp: "); 
    Serial.print(temperature); 
    Serial.println(" °C");
  }

  Serial.println("=================================\n");
  
  // DHT22 slow sensor, tai 2 second delay dewa holo
  delay(2000); 
}
