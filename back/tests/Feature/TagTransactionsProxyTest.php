<?php

namespace Tests\Feature;

use App\Http\Controllers\TagController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class TagTransactionsProxyTest extends TestCase
{
    public function test_tag_transactions_use_the_scoped_proxy_route()
    {
        $route = app('router')->getRoutes()->match(Request::create('/api/tags/7/transactions', 'GET'));

        $this->assertSame(TagController::class.'@getTransactions', $route->getActionName());
    }

    public function test_tag_transactions_proxy_the_query_and_authorization()
    {
        Http::fake(fn () => Http::response(['data' => [['id' => '42']]], 200));

        $this->getJson('/api/tags/7/transactions?page=2&limit=50', ['Authorization' => 'Bearer test-token'])
            ->assertOk()
            ->assertJsonPath('data.0.id', '42');

        Http::assertSent(fn ($request) => $request->url() === config('app.firefly_url').'/api/v1/tags/7/transactions?page=2&limit=50'
            && $request->hasHeader('Authorization', 'Bearer test-token'));
    }
}
