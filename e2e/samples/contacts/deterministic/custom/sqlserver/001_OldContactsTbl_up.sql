-- Legacy contact table imported from an older application; mappings in datasource.yaml bridge to canonical snake_case.
CREATE TABLE [OldContactsTbl] (
  [CntID] NVARCHAR(64) NOT NULL PRIMARY KEY,
  [FirstNm] NVARCHAR(128) NOT NULL,
  [LastNm] NVARCHAR(128) NOT NULL,
  [EmailAddr] NVARCHAR(256),
  [ImpDate] DATETIME2
);
