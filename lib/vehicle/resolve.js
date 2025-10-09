export async function resolveVehicleFromVIN(vin) {
  // TODO: map your real NHTSA VIN result to {class, powertrain, mpgMixed/kwhPer100mi}
  return {
    year: 2021,
    make: "Generic",
    model: "Sedan",
    class: "midsize_sedan_ICE",
    powertrain: "ICE",
    mpgMixed: 29
  };
}
