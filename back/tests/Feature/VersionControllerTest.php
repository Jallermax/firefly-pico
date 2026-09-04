<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class VersionControllerTest extends TestCase
{
    private array $versionFiles = [];

    protected function setUp(): void
    {
        parent::setUp();

        foreach (['VERSION', 'UPSTREAM_VERSION'] as $name) {
            $path = base_path($name);
            $this->versionFiles[$path] = file_exists($path) ? file_get_contents($path) : null;
        }

        Http::fake([
            'api.github.com/repos/cioraneanu/firefly-pico/tags*' => Http::response([
                ['name' => '1.12.1-4-dev'],
                ['name' => '1.12.1-3-dev'],
                ['name' => '1.12.0'],
            ]),
        ]);
    }

    protected function tearDown(): void
    {
        foreach ($this->versionFiles as $path => $contents) {
            if ($contents === null) {
                if (file_exists($path)) {
                    unlink($path);
                }
            } else {
                file_put_contents($path, $contents);
            }
        }

        parent::tearDown();
    }

    public function test_personal_revision_uses_upstream_dev_release_channel()
    {
        file_put_contents(base_path('VERSION'), '0eca50a200e5b9a76d08de0e59d69851c9d2e60e');
        file_put_contents(base_path('UPSTREAM_VERSION'), '1.12.1-3-dev');

        $this->getJson('/api/info')
            ->assertOk()
            ->assertJsonPath('latest_version', '1.12.1-4-dev');
    }

    public function test_historical_dev_image_uses_version_file_release_channel()
    {
        if (file_exists(base_path('UPSTREAM_VERSION'))) {
            unlink(base_path('UPSTREAM_VERSION'));
        }
        file_put_contents(base_path('VERSION'), '1.12.1-3-dev');

        $this->getJson('/api/info')
            ->assertOk()
            ->assertJsonPath('latest_version', '1.12.1-4-dev');
    }
}
