-- Legacy contact table imported from an older application; mappings in datasource.yaml bridge to canonical snake_case.
CREATE TABLE "OldContactsTbl" (
  "CntID" VARCHAR(64) NOT NULL PRIMARY KEY,
  "FirstNm" VARCHAR(128) NOT NULL,
  "LastNm" VARCHAR(128) NOT NULL,
  "EmailAddr" VARCHAR(256),
  "ImpDate" TEXT
);
