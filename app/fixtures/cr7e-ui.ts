import type { PackageRegistryProjectionV1 } from "../components/package-registry-list";

export const cr7ePackageRegistryFixture: readonly PackageRegistryProjectionV1[] = [
  { packageId:"package:procedure:build-check:1",projectId:"project.wayfarer.lazy-river",kind:"procedure",name:"build-and-check",version:"1.0.0",packageDigest:"sha256:3cfb194242954c7a7d276c2b889d9bb19735405405005bd7bd78d56b97d61228",state:"active",trust:"reviewed",adapterId:"adapter.hermes.gateway.v1",adapterVersion:"1.0.0",platform:"macos",compatibility:"verified" },
  { packageId:"package:knowledge:control-room:1",projectId:"project.blooms.content-ops",kind:"knowledge",name:"project-facts",version:"1.0.0",packageDigest:"sha256:50947783295c44558ced6fe13225cdb33b8649ba49fb61e64393d4ef979c8401",state:"candidate",trust:"unreviewed",adapterId:"adapter.hermes.gateway.v1",adapterVersion:"1.0.0",platform:"linux",compatibility:"pending" },
  { packageId:"package:procedure:build-check:2",projectId:"project.wayfarer.lazy-river",kind:"procedure",name:"build-and-check",version:"2.0.0",packageDigest:"sha256:eafc0c2b20d75110d7c1febf1af901c5557cc62b2a649c5b050220018000bc97",state:"rejected",trust:"rejected",adapterId:"adapter.hermes.gateway.v1",adapterVersion:"1.0.0",platform:"macos",compatibility:"verified" },
];
